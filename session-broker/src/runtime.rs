use crate::command::pty_size;
pub use crate::command::{command_for_request, default_shell_command};
use crate::output::{spawn_reader_thread, OutputGate, OutputSink, ProcessStatus};
pub use crate::output::{InitialCursorPositionQuery, OutputBuffer, MAX_OUTPUT_BYTES};
use crate::store::{now_ms, RestorableSession, SessionStore, StoredSession};
use portable_pty::{native_pty_system, Child, MasterPty};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

const MAX_SESSION_ID_BYTES: usize = 128;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnSessionRequest {
    pub session_id: String,
    pub cwd: Option<String>,
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIdRequest {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSessionRequest {
    pub session_id: String,
    pub run_id: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadSessionRequest {
    pub session_id: String,
    pub after: u64,
}

/// Subscribe to a session's output from byte `after` onwards. See `Request::Attach`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachSessionRequest {
    pub session_id: String,
    pub after: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteSessionRequest {
    pub session_id: String,
    pub run_id: u64,
    /// A paste can be kilobytes; it crosses as base64 for the same reason output does.
    #[serde(with = "crate::base64")]
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizeSessionRequest {
    pub session_id: String,
    pub run_id: u64,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub session_id: String,
    pub run_id: u64,
    pub process_id: Option<u32>,
    pub running: bool,
    pub exit_code: Option<u32>,
    pub read_closed: bool,
    pub read_error: Option<String>,
    /// Output high-water mark. A renderer attaching with no memory of this run (a fresh app
    /// process re-attaching to a broker-owned session) must suppress terminal protocol responses
    /// for everything before this cursor, or xterm answers stale queries into the live shell.
    pub next: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRead {
    pub session_id: String,
    pub run_id: u64,
    pub start: u64,
    pub next: u64,
    /// Raw PTY bytes, base64 on the wire. A JSON number array cost three to four characters per
    /// byte and a per-number parse, on the one path where every millisecond is felt as typing lag.
    #[serde(with = "crate::base64")]
    pub bytes: Vec<u8>,
    pub truncated: bool,
    pub running: bool,
    pub exit_code: Option<u32>,
    pub read_closed: bool,
    pub read_error: Option<String>,
}

/// One session the broker is holding, as an operator would want to see it listed.
///
/// The timing and launch fields default when absent so an app can read the answer of a broker
/// from before they existed — a broker outlives the app that started it — and vice versa. Adding
/// defaulted fields is not a protocol change; `PROTOCOL_VERSION` stays put.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSession {
    pub session_id: String,
    pub run_id: u64,
    pub process_id: Option<u32>,
    pub running: bool,
    /// When this run was spawned, in milliseconds since the Unix epoch.
    #[serde(default)]
    pub started_at_ms: Option<u64>,
    /// When the PTY last produced output, in milliseconds since the Unix epoch; absent until it
    /// has produced any. The only activity signal that needs no process inspection on either OS.
    #[serde(default)]
    pub last_output_ms: Option<u64>,
    /// The working directory the run was asked to start in.
    #[serde(default)]
    pub cwd: Option<String>,
    /// The program the run was asked to start; absent means the OS default shell.
    #[serde(default)]
    pub command: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeError {
    InvalidRequest(String),
    DuplicateSession(String),
    RunningSession(String),
    MissingSession(String),
    Process(String),
    Internal(String),
}

impl fmt::Display for RuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRequest(message) => {
                write!(formatter, "invalid session request: {message}")
            }
            Self::DuplicateSession(id) => write!(formatter, "session already exists: {id}"),
            Self::RunningSession(id) => {
                write!(formatter, "cannot discard running session: {id}")
            }
            Self::MissingSession(id) => write!(formatter, "session not found: {id}"),
            Self::Process(message) => write!(formatter, "session process error: {message}"),
            Self::Internal(message) => write!(formatter, "session runtime error: {message}"),
        }
    }
}

impl std::error::Error for RuntimeError {}

#[derive(Default)]
pub struct SessionRuntime {
    sessions: Mutex<HashMap<String, Arc<SessionProcess>>>,
    next_run_id: Mutex<u64>,
    store: Arc<SessionStore>,
}

impl SessionRuntime {
    /// A runtime whose bounded internal session evidence is recorded under `root`.
    /// `SessionRuntime::default()` keeps nothing, which is what tests want.
    pub fn with_store(store: SessionStore) -> Self {
        Self {
            store: Arc::new(store),
            ..Self::default()
        }
    }

    /// Stored session records, newest first. The current product does not expose this as recovery.
    pub fn restorable(&self) -> Vec<RestorableSession> {
        self.store.restorable()
    }

    /// The output kept on disk for a session id, oldest first.
    pub fn stored_output(&self, session_id: &str) -> Vec<u8> {
        self.store.output(session_id)
    }

    /// Every session this broker holds, alive or finished — the `tmux ls` of this product.
    ///
    /// Sessions outlive the panes that opened them, by design, and until now nothing could see
    /// them: closing a pane detached, the app forgot, and shells accumulated for days with no way
    /// to find or stop them. This is what an operator needs to clean up.
    pub fn live_sessions(&self) -> Vec<LiveSession> {
        let sessions = match lock(&self.sessions, "session registry") {
            Ok(sessions) => sessions.values().cloned().collect::<Vec<_>>(),
            Err(_) => return Vec::new(),
        };
        let mut listed = sessions
            .iter()
            .filter_map(|session| session.snapshot().ok().map(|snapshot| (session, snapshot)))
            .map(|(session, snapshot)| LiveSession {
                session_id: snapshot.session_id,
                run_id: snapshot.run_id,
                process_id: snapshot.process_id,
                running: snapshot.running,
                started_at_ms: Some(session.started_at_ms),
                last_output_ms: match session.last_output_ms.load(Ordering::Relaxed) {
                    0 => None,
                    stamp => Some(stamp),
                },
                cwd: session.cwd.clone(),
                command: session.command.clone(),
            })
            .collect::<Vec<_>>();
        listed.sort_by_key(|session| session.run_id);
        listed
    }

    /// Whether any child is still running. The broker uses this to decide it may exit when its
    /// last client disconnects: with nothing alive there is nothing to keep alive.
    pub fn has_running_sessions(&self) -> bool {
        let sessions = match lock(&self.sessions, "session registry") {
            Ok(sessions) => sessions.values().cloned().collect::<Vec<_>>(),
            Err(_) => return true,
        };
        sessions
            .iter()
            .any(|session| session.snapshot().map(|s| s.running).unwrap_or(true))
    }

    /// Whether session records are being written at all.
    pub fn persists(&self) -> bool {
        self.store.enabled()
    }
}

struct SessionProcess {
    id: String,
    run_id: u64,
    process_id: Option<u32>,
    started_at_ms: u64,
    cwd: Option<String>,
    command: Option<String>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Option<Box<dyn Write + Send>>>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    output: Arc<Mutex<OutputBuffer>>,
    status: Arc<Mutex<ProcessStatus>>,
    /// Paired with `output`. The reader thread signals it after every append and once more when
    /// the PTY closes, so a streaming client sleeps on it instead of polling on a timer.
    changed: Arc<Condvar>,
    /// Attached streams' cursors; the reader thread waits on it rather than evict their bytes.
    gate: Arc<OutputGate>,
    /// Stamped by the reader thread on every append; 0 until the PTY has produced anything.
    last_output_ms: Arc<AtomicU64>,
}

/// How long `wait_read` sleeps between status checks while no output arrives. The child's exit is
/// observed by `try_wait`, not by the reader thread — on ConPTY the reader can outlive the process
/// — so an idle wait re-checks on this cadence rather than trusting the condvar alone.
const WAIT_READ_SLICE: Duration = Duration::from_millis(250);

/// A stream's registration with a session's output gate. While it lives, the PTY reader thread
/// will not evict bytes this stream has not read; dropping it lets the reader run free again.
pub struct AttachedReader {
    process: Arc<SessionProcess>,
    slot: u64,
}

impl AttachedReader {
    /// `SessionRuntime::wait_read` for an attached stream: asking for bytes after `after` is the
    /// statement that everything before it has been sent, which is what lets the reader go on.
    pub fn wait_read(&self, after: u64, timeout: Duration) -> Result<SessionRead, RuntimeError> {
        self.process.gate.advance(self.slot, after);
        wait_read_on(&self.process, after, timeout)
    }
}

impl Drop for AttachedReader {
    fn drop(&mut self) {
        self.process.gate.detach(self.slot);
    }
}

impl SessionRuntime {
    pub fn spawn(&self, request: SpawnSessionRequest) -> Result<SessionSnapshot, RuntimeError> {
        validate_spawn_request(&request)?;
        if self.contains(&request.session_id)? {
            return Err(RuntimeError::DuplicateSession(request.session_id));
        }
        let run_id = self.next_run_id()?;

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(pty_size(request.cols, request.rows))
            .map_err(|error| RuntimeError::Process(error.to_string()))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| RuntimeError::Process(error.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| RuntimeError::Process(error.to_string()))?;
        let writer = Arc::new(Mutex::new(Some(writer)));

        // The child can create its transcript before spawn_command returns. Capture the launch
        // boundary first so transcript discovery never treats that new record as an older pane.
        let started_at_ms = now_ms();
        let command = command_for_request(&request);
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| RuntimeError::Process(error.to_string()))?;
        let process_id = child.process_id();
        drop(pair.slave);

        let output = Arc::new(Mutex::new(OutputBuffer::default()));
        let changed = Arc::new(Condvar::new());
        let gate = Arc::new(OutputGate::default());
        let last_output_ms = Arc::new(AtomicU64::new(0));
        let status = Arc::new(Mutex::new(ProcessStatus {
            running: true,
            ..ProcessStatus::default()
        }));
        // Recorded before the reader starts so no output can be appended to a session that has no
        // definition on disk. A store failure must not stop a session the user asked for.
        let _ = self.store.record(&StoredSession {
            session_id: request.session_id.clone(),
            run_id: Some(run_id),
            cwd: request.cwd.clone(),
            command: request.command.clone(),
            args: request.args.clone(),
            cols: request.cols,
            rows: request.rows,
            started_at_ms,
        });

        if let Err(error) = spawn_reader_thread(
            request.session_id.clone(),
            reader,
            OutputSink {
                output: Arc::clone(&output),
                status: Arc::clone(&status),
                changed: Arc::clone(&changed),
                gate: Arc::clone(&gate),
                last_output_ms: Arc::clone(&last_output_ms),
            },
            Arc::clone(&writer),
            Arc::clone(&self.store),
        ) {
            let _ = child.kill();
            return Err(error);
        }

        let process = Arc::new(SessionProcess {
            id: request.session_id.clone(),
            run_id,
            process_id,
            started_at_ms,
            cwd: request.cwd.clone(),
            command: request.command.clone(),
            master: Mutex::new(Some(pair.master)),
            writer,
            child: Mutex::new(child),
            output,
            status,
            changed,
            gate,
            last_output_ms,
        });

        let mut sessions = lock(&self.sessions, "session registry")?;
        if sessions.contains_key(&request.session_id) {
            return Err(RuntimeError::DuplicateSession(request.session_id));
        }
        sessions.insert(request.session_id, Arc::clone(&process));
        drop(sessions);
        process.snapshot()
    }

    pub fn snapshot(
        &self,
        request: SessionIdRequest,
    ) -> Result<Option<SessionSnapshot>, RuntimeError> {
        let process = {
            let sessions = lock(&self.sessions, "session registry")?;
            sessions.get(&request.session_id).cloned()
        };
        process.map(|session| session.snapshot()).transpose()
    }

    pub fn read(&self, request: ReadSessionRequest) -> Result<SessionRead, RuntimeError> {
        let process = self.session(&request.session_id)?;
        process.refresh_status()?;
        // Lock order everywhere: output, then status. `wait_read` sleeps holding neither, but
        // wakes with `output` and then takes `status`; anything taking them the other way would
        // deadlock against it.
        let output = lock(&process.output, "output buffer")?;
        process.assemble_read(&output, request.after)
    }

    /// `read`, but patient: when nothing is buffered past `after` and the session is still alive,
    /// block until the reader thread appends more or `timeout` passes, whichever is first. This is
    /// the primitive behind `Attach` — a streaming connection sits in it instead of a client
    /// polling on a timer — and it is what makes a keystroke's echo arrive at PTY pace. An
    /// exited-and-drained session returns at once so a stream can finish; a timeout returns the
    /// empty read with current status, which the stream forwards as its keepalive.
    ///
    /// A plain `wait_read` is not attached: the reader thread never waits for it. A stream that
    /// wants its bytes kept goes through `attach` and reads on the handle.
    pub fn wait_read(
        &self,
        request: ReadSessionRequest,
        timeout: Duration,
    ) -> Result<SessionRead, RuntimeError> {
        let process = self.session(&request.session_id)?;
        wait_read_on(&process, request.after, timeout)
    }

    /// Register an output stream with a session, so the PTY reader holds back rather than evict
    /// bytes the stream has not sent yet. See `OutputGate`.
    pub fn attach(&self, session_id: &str) -> Result<AttachedReader, RuntimeError> {
        let process = self.session(session_id)?;
        let slot = process.gate.attach();
        Ok(AttachedReader { process, slot })
    }

    pub fn write(&self, request: WriteSessionRequest) -> Result<(), RuntimeError> {
        let process = self.session(&request.session_id)?;
        validate_run_id(&process, request.run_id)?;
        process.refresh_status()?;
        if !lock(&process.status, "process status")?.running {
            return Err(RuntimeError::Process(
                "cannot write to an exited session".into(),
            ));
        }
        let mut writer = lock(&process.writer, "PTY writer")?;
        let writer = writer
            .as_mut()
            .ok_or_else(|| RuntimeError::Process("PTY input is closed".into()))?;
        writer
            .write_all(&request.data)
            .and_then(|()| writer.flush())
            .map_err(|error| RuntimeError::Process(error.to_string()))
    }

    pub fn resize(&self, request: ResizeSessionRequest) -> Result<(), RuntimeError> {
        validate_size(request.cols, request.rows)?;
        let process = self.session(&request.session_id)?;
        validate_run_id(&process, request.run_id)?;
        let master = lock(&process.master, "PTY master")?;
        let master = master
            .as_ref()
            .ok_or_else(|| RuntimeError::Process("PTY is closed".into()))?;
        master
            .resize(pty_size(request.cols, request.rows))
            .map_err(|error| RuntimeError::Process(error.to_string()))
    }

    pub fn kill(&self, request: RunSessionRequest) -> Result<SessionSnapshot, RuntimeError> {
        let process = self.session(&request.session_id)?;
        validate_run_id(&process, request.run_id)?;
        process.refresh_status()?;
        if !lock(&process.status, "process status")?.running {
            return process.snapshot();
        }
        let kill_result = {
            let mut child = lock(&process.child, "child process")?;
            child.kill()
        };
        if let Err(error) = kill_result {
            process.refresh_status()?;
            if !lock(&process.status, "process status")?.running {
                return process.snapshot();
            }
            return Err(RuntimeError::Process(error.to_string()));
        }
        sweep_process_tree(process.process_id);
        process.snapshot()
    }

    pub fn discard(&self, request: SessionIdRequest) -> Result<(), RuntimeError> {
        let removed = {
            let mut sessions = lock(&self.sessions, "session registry")?;
            let process = sessions
                .get(&request.session_id)
                .cloned()
                .ok_or_else(|| RuntimeError::MissingSession(request.session_id.clone()))?;
            if process.snapshot()?.running {
                return Err(RuntimeError::RunningSession(request.session_id));
            }
            sessions.remove(&request.session_id)
        };
        drop(removed);
        // Discard is the explicit "this run is over for good", so its internal record goes too.
        self.store.forget(&request.session_id);
        Ok(())
    }

    fn contains(&self, session_id: &str) -> Result<bool, RuntimeError> {
        Ok(lock(&self.sessions, "session registry")?.contains_key(session_id))
    }

    fn next_run_id(&self) -> Result<u64, RuntimeError> {
        let mut next = lock(&self.next_run_id, "run id counter")?;
        *next = next
            .checked_add(1)
            .ok_or_else(|| RuntimeError::Internal("run id counter exhausted".into()))?;
        Ok(*next)
    }

    fn session(&self, session_id: &str) -> Result<Arc<SessionProcess>, RuntimeError> {
        lock(&self.sessions, "session registry")?
            .get(session_id)
            .cloned()
            .ok_or_else(|| RuntimeError::MissingSession(session_id.to_owned()))
    }
}

fn wait_read_on(
    process: &SessionProcess,
    after: u64,
    timeout: Duration,
) -> Result<SessionRead, RuntimeError> {
    let deadline = Instant::now() + timeout;
    let mut output = lock(&process.output, "output buffer")?;
    loop {
        // The child's exit is seen by try_wait, so look before deciding to sleep.
        process.refresh_status()?;
        let read = process.assemble_read(&output, after)?;
        let finished = !read.running && read.read_closed;
        let now = Instant::now();
        if !read.bytes.is_empty() || finished || now >= deadline {
            return Ok(read);
        }
        let slice = (deadline - now).min(WAIT_READ_SLICE);
        output = match process.changed.wait_timeout(output, slice) {
            Ok((guard, _)) => guard,
            Err(poisoned) => poisoned.into_inner().0,
        };
    }
}

impl SessionProcess {
    /// The bytes past `after` plus the status at that moment. Callers hold the output lock so the
    /// cursor they are handed is the one the bytes were read at.
    fn assemble_read(
        &self,
        output: &OutputBuffer,
        after: u64,
    ) -> Result<SessionRead, RuntimeError> {
        let read = output.read(after);
        let status = lock(&self.status, "process status")?;
        Ok(SessionRead {
            session_id: self.id.clone(),
            run_id: self.run_id,
            start: read.start,
            next: read.next,
            bytes: read.bytes,
            truncated: read.truncated,
            running: status.running,
            exit_code: status.exit_code,
            read_closed: status.read_closed,
            read_error: status.read_error.clone(),
        })
    }

    fn close_pty(&self) -> Result<(), RuntimeError> {
        drop(lock(&self.writer, "PTY writer")?.take());
        let Some(master) = lock(&self.master, "PTY master")?.take() else {
            return Ok(());
        };
        close_master_async(&self.id, master)
    }

    fn refresh_status(&self) -> Result<(), RuntimeError> {
        let exit = lock(&self.child, "child process")?
            .try_wait()
            .map_err(|error| RuntimeError::Process(error.to_string()))?;
        if let Some(exit) = exit {
            {
                let mut status = lock(&self.status, "process status")?;
                status.running = false;
                status.exit_code = Some(exit.exit_code());
            }
            self.close_pty()?;
            // A stream waiting for output must learn about the exit now, not at its next slice.
            self.changed.notify_all();
        }
        Ok(())
    }

    fn snapshot(&self) -> Result<SessionSnapshot, RuntimeError> {
        self.refresh_status()?;
        let next = lock(&self.output, "output buffer")?.next;
        let status = lock(&self.status, "process status")?;
        Ok(SessionSnapshot {
            session_id: self.id.clone(),
            run_id: self.run_id,
            process_id: self.process_id,
            running: status.running,
            exit_code: status.exit_code,
            read_closed: status.read_closed,
            read_error: status.read_error.clone(),
            next,
        })
    }
}

impl Drop for SessionProcess {
    fn drop(&mut self) {
        if let Ok(child) = self.child.get_mut() {
            let _ = child.kill();
        }
        if let Ok(mut writer) = self.writer.lock() {
            drop(writer.take());
        }
        if let Ok(master) = self.master.get_mut() {
            if let Some(master) = master.take() {
                let _ = close_master_async(&self.id, master);
            }
        }
    }
}

fn close_master_async(
    session_id: &str,
    master: Box<dyn MasterPty + Send>,
) -> Result<(), RuntimeError> {
    let retained = Arc::new(Mutex::new(Some(master)));
    let worker_copy = Arc::clone(&retained);
    let result = thread::Builder::new()
        .name(format!("talkak-pty-closer-{session_id}"))
        .spawn(move || {
            if let Ok(mut current) = worker_copy.lock() {
                drop(current.take());
            }
        });
    match result {
        Ok(_) => Ok(()),
        Err(error) => {
            // A synchronous master drop can block indefinitely on older ConPTY versions.
            // Leak only on the exceptional thread-creation failure path instead.
            std::mem::forget(retained);
            Err(RuntimeError::Internal(format!(
                "failed to start PTY closer: {error}"
            )))
        }
    }
}

fn validate_spawn_request(request: &SpawnSessionRequest) -> Result<(), RuntimeError> {
    if request.session_id.trim().is_empty()
        || request.session_id.len() > MAX_SESSION_ID_BYTES
        || request.session_id.chars().any(char::is_control)
    {
        return Err(RuntimeError::InvalidRequest(
            "sessionId must be a non-empty, printable identifier up to 128 bytes".into(),
        ));
    }
    validate_size(request.cols, request.rows)?;
    if let Some(cwd) = request.cwd.as_deref() {
        let path = Path::new(cwd);
        if !path.is_absolute() {
            return Err(RuntimeError::InvalidRequest(
                "working directory must be an absolute path".into(),
            ));
        }
        if !path.is_dir() {
            return Err(RuntimeError::InvalidRequest(format!(
                "working directory does not exist: {cwd}"
            )));
        }
    }
    if request.command.as_deref().is_some_and(str::is_empty) {
        return Err(RuntimeError::InvalidRequest(
            "command must be omitted or non-empty".into(),
        ));
    }
    if request.command.is_none() && !request.args.is_empty() {
        return Err(RuntimeError::InvalidRequest(
            "arguments require an explicit command".into(),
        ));
    }
    Ok(())
}

fn validate_size(cols: u16, rows: u16) -> Result<(), RuntimeError> {
    if cols == 0 || rows == 0 {
        return Err(RuntimeError::InvalidRequest(
            "terminal columns and rows must be greater than zero".into(),
        ));
    }
    Ok(())
}

fn validate_run_id(process: &SessionProcess, run_id: u64) -> Result<(), RuntimeError> {
    if process.run_id == run_id {
        return Ok(());
    }
    Err(RuntimeError::Process("session run changed".into()))
}

/// Killing the shell is not killing the session's work: on Windows the shell's children — an agent
/// CLI mid-run — survive `child.kill()` and keep running blind, holding their own session files
/// open. Sweep the whole tree, best-effort; the shell itself is already dead or dying.
#[cfg(windows)]
fn sweep_process_tree(process_id: Option<u32>) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let Some(pid) = process_id else { return };
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

/// On unix the PTY teardown delivers SIGHUP to the session's process group already.
#[cfg(not(windows))]
fn sweep_process_tree(_process_id: Option<u32>) {}

pub(crate) fn lock<'a, T>(
    mutex: &'a Mutex<T>,
    name: &str,
) -> Result<MutexGuard<'a, T>, RuntimeError> {
    match mutex.lock() {
        Ok(guard) => Ok(guard),
        Err(poisoned) => {
            crate::logging::log(&format!("recovering poisoned {name} lock"));
            mutex.clear_poison();
            Ok(poisoned.into_inner())
        }
    }
}
