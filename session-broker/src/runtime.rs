use crate::store::{now_ms, RestorableSession, SessionStore, StoredSession};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;

// Exact internal safety limits, not product promises.
pub const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_READ_BYTES: usize = 64 * 1024;
const MAX_SESSION_ID_BYTES: usize = 128;
const CURSOR_POSITION_QUERY: &[u8] = b"\x1b[6n";
const INHERITED_CURSOR_POSITION_REPORT: &[u8] = b"\x1b[1;1R";

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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteSessionRequest {
    pub session_id: String,
    pub run_id: u64,
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
    pub bytes: Vec<u8>,
    pub truncated: bool,
    pub running: bool,
    pub exit_code: Option<u32>,
    pub read_closed: bool,
    pub read_error: Option<String>,
}

/// One session the broker is holding, as an operator would want to see it listed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSession {
    pub session_id: String,
    pub run_id: u64,
    pub process_id: Option<u32>,
    pub running: bool,
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
            .filter_map(|session| session.snapshot().ok())
            .map(|snapshot| LiveSession {
                session_id: snapshot.session_id,
                run_id: snapshot.run_id,
                process_id: snapshot.process_id,
                running: snapshot.running,
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
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Option<Box<dyn Write + Send>>>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    output: Arc<Mutex<OutputBuffer>>,
    status: Arc<Mutex<ProcessStatus>>,
}

#[derive(Debug, Default)]
struct ProcessStatus {
    running: bool,
    exit_code: Option<u32>,
    read_closed: bool,
    read_error: Option<String>,
}

#[derive(Debug)]
pub struct InitialCursorPositionQuery {
    enabled: bool,
    answered: bool,
    pending: Vec<u8>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct CursorQueryObservation {
    pub output: Vec<u8>,
    pub should_respond: bool,
}

impl InitialCursorPositionQuery {
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled,
            answered: false,
            pending: Vec::new(),
        }
    }

    pub fn observe(&mut self, bytes: &[u8]) -> CursorQueryObservation {
        if !self.enabled || self.answered {
            return CursorQueryObservation {
                output: bytes.to_vec(),
                should_respond: false,
            };
        }

        let mut output = Vec::with_capacity(self.pending.len() + bytes.len());
        for (index, byte) in bytes.iter().enumerate() {
            if *byte == CURSOR_POSITION_QUERY[self.pending.len()] {
                self.pending.push(*byte);
                if self.pending.len() == CURSOR_POSITION_QUERY.len() {
                    self.pending.clear();
                    self.answered = true;
                    output.extend_from_slice(&bytes[index + 1..]);
                    break;
                }
                continue;
            }

            output.append(&mut self.pending);
            if *byte == CURSOR_POSITION_QUERY[0] {
                self.pending.push(*byte);
            } else {
                output.push(*byte);
            }
        }

        CursorQueryObservation {
            output,
            should_respond: self.answered,
        }
    }

    pub fn finish(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.pending)
    }
}

#[derive(Debug, Default)]
pub struct OutputBuffer {
    start: u64,
    next: u64,
    bytes: VecDeque<u8>,
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
            Arc::clone(&output),
            Arc::clone(&status),
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
            master: Mutex::new(Some(pair.master)),
            writer,
            child: Mutex::new(child),
            output,
            status,
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
        let status = lock(&process.status, "process status")?;
        let read = lock(&process.output, "output buffer")?.read(request.after);
        Ok(SessionRead {
            session_id: process.id.clone(),
            run_id: process.run_id,
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

impl SessionProcess {
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

#[derive(Debug)]
struct OutputRead {
    start: u64,
    next: u64,
    bytes: Vec<u8>,
    truncated: bool,
}

impl OutputBuffer {
    pub fn append(&mut self, chunk: &[u8]) {
        self.next = self.next.saturating_add(chunk.len() as u64);
        self.bytes.extend(chunk);
        let overflow = self.bytes.len().saturating_sub(MAX_OUTPUT_BYTES);
        if overflow > 0 {
            self.bytes.drain(..overflow);
            self.start = self.start.saturating_add(overflow as u64);
        }
    }

    fn read(&self, after: u64) -> OutputRead {
        let cursor = after.max(self.start).min(self.next);
        let offset = (cursor - self.start) as usize;
        let bytes = self
            .bytes
            .iter()
            .skip(offset)
            .take(MAX_READ_BYTES)
            .copied()
            .collect::<Vec<_>>();
        OutputRead {
            start: cursor,
            next: cursor.saturating_add(bytes.len() as u64),
            bytes,
            truncated: after < self.start,
        }
    }

    #[cfg(test)]
    pub fn read_for_test(&self, after: u64) -> TestOutputRead {
        let read = self.read(after);
        TestOutputRead {
            start: read.start,
            truncated: read.truncated,
        }
    }
}

#[cfg(test)]
pub struct TestOutputRead {
    pub start: u64,
    pub truncated: bool,
}

fn spawn_reader_thread(
    session_id: String,
    mut reader: Box<dyn Read + Send>,
    output: Arc<Mutex<OutputBuffer>>,
    status: Arc<Mutex<ProcessStatus>>,
    writer: Arc<Mutex<Option<Box<dyn Write + Send>>>>,
    store: Arc<SessionStore>,
) -> Result<(), RuntimeError> {
    thread::Builder::new()
        .name(format!("talkak-pty-reader-{session_id}"))
        .spawn(move || {
            let mut chunk = [0_u8; 8192];
            // portable-pty requests cursor inheritance from ConPTY. On Windows, answer and
            // remove that one host-level query; later application queries remain for xterm.
            let mut inherited_cursor_query = InitialCursorPositionQuery::new(cfg!(windows));
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(read) => {
                        let observation = inherited_cursor_query.observe(&chunk[..read]);
                        if observation.should_respond {
                            if let Ok(mut current_writer) = writer.lock() {
                                if let Some(current_writer) = current_writer.as_mut() {
                                    let _ = current_writer
                                        .write_all(INHERITED_CURSOR_POSITION_REPORT)
                                        .and_then(|()| current_writer.flush());
                                }
                            }
                        }
                        // Recorded before the in-memory append so the on-disk log is never behind
                        // what the live terminal already showed.
                        store.append_output(&session_id, &observation.output);
                        if let Ok(mut buffer) = output.lock() {
                            buffer.append(&observation.output);
                        } else {
                            break;
                        }
                    }
                    Err(error) => {
                        if let Ok(mut current) = status.lock() {
                            if current.running {
                                current.read_error = Some(error.to_string());
                            }
                        }
                        break;
                    }
                }
            }
            let trailing = inherited_cursor_query.finish();
            if !trailing.is_empty() {
                store.append_output(&session_id, &trailing);
                if let Ok(mut buffer) = output.lock() {
                    buffer.append(&trailing);
                }
            }
            if let Ok(mut current) = status.lock() {
                current.read_closed = true;
            }
        })
        .map(|_| ())
        .map_err(|error| RuntimeError::Internal(format!("failed to start PTY reader: {error}")))
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

pub fn command_for_request(request: &SpawnSessionRequest) -> CommandBuilder {
    let mut command = match request.command.as_deref() {
        Some(program) => CommandBuilder::new(program),
        None => default_shell_command(),
    };
    command.args(&request.args);
    if let Some(cwd) = request.cwd.as_deref() {
        command.cwd(cwd);
    }
    // portable-pty inherits this process's environment, and a Windows GUI process carries neither
    // variable, so every colour-capable CLI fell back to monochrome. The renderer is xterm.js on
    // both platforms, so tell the child exactly what it is talking to.
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    // ...and drop anything in the inherited environment that countermands that. The broker outlives
    // the app that starts it, so whatever environment happened to launch it is stamped on every
    // shell it will ever open. Launched once from a terminal carrying NO_COLOR=1, it set
    // $PSStyle.OutputRendering to PlainText in every pane — `Write-Host -ForegroundColor Red` came
    // out as bare text — while TERM and COLORTERM sat there claiming the opposite.
    for suppressor in ["NO_COLOR", "ANSI_COLORS_DISABLED"] {
        command.env_remove(suppressor);
    }
    // CLICOLOR=0 is the BSD and macOS spelling of the same instruction, and this product has to
    // behave identically on both platforms — a mac launched from a shell carrying it would lose
    // colour exactly as Windows did with NO_COLOR. Asked of the builder, which is already seeded
    // from this process's environment, so the question is what the child would really receive.
    // Only the disabling "0" goes: CLICOLOR_FORCE and a deliberate CLICOLOR=1 are someone choosing
    // colour, and removing those would override the user rather than the accident.
    if command
        .get_env("CLICOLOR")
        .is_some_and(|value| value == "0")
    {
        command.env_remove("CLICOLOR");
    }
    command
}

/// The shell a pane boots when the project names no command. portable-pty's default on Windows is
/// %COMSPEC% — cmd.exe — where a developer's first `ls` answers "not recognized". A developer
/// workspace boots a developer shell: pwsh if installed, Windows PowerShell otherwise, and cmd only
/// when neither resolves. Unix keeps the login shell portable-pty already picks.
#[cfg(windows)]
pub fn default_shell_command() -> CommandBuilder {
    for shell in ["pwsh.exe", "powershell.exe"] {
        if resolves_on_path(shell) {
            let mut command = CommandBuilder::new(shell);
            // Skip the copyright banner; the user's profile still loads.
            command.args(["-NoLogo"]);
            return command;
        }
    }
    CommandBuilder::new_default_prog()
}

#[cfg(not(windows))]
pub fn default_shell_command() -> CommandBuilder {
    CommandBuilder::new_default_prog()
}

#[cfg(windows)]
fn resolves_on_path(program: &str) -> bool {
    let Some(search_path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&search_path)
        .filter(|directory| !directory.as_os_str().is_empty())
        .any(|directory| directory.join(program).is_file())
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

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
