use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;

// Exact internal safety limits, not product promises.
pub(crate) const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_READ_BYTES: usize = 64 * 1024;
const MAX_SESSION_ID_BYTES: usize = 128;
const CURSOR_POSITION_QUERY: &[u8] = b"\x1b[6n";
const CURSOR_POSITION_REPORT: &[u8] = b"\x1b[1;1R";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpawnSessionRequest {
    pub(crate) session_id: String,
    pub(crate) cwd: Option<String>,
    pub(crate) command: Option<String>,
    #[serde(default)]
    pub(crate) args: Vec<String>,
    pub(crate) cols: u16,
    pub(crate) rows: u16,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionIdRequest {
    pub(crate) session_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadSessionRequest {
    pub(crate) session_id: String,
    pub(crate) after: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WriteSessionRequest {
    pub(crate) session_id: String,
    pub(crate) data: Vec<u8>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResizeSessionRequest {
    pub(crate) session_id: String,
    pub(crate) cols: u16,
    pub(crate) rows: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionSnapshot {
    pub(crate) session_id: String,
    pub(crate) run_id: u64,
    pub(crate) process_id: Option<u32>,
    pub(crate) running: bool,
    pub(crate) exit_code: Option<u32>,
    pub(crate) read_closed: bool,
    pub(crate) read_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionRead {
    pub(crate) session_id: String,
    pub(crate) run_id: u64,
    pub(crate) start: u64,
    pub(crate) next: u64,
    pub(crate) bytes: Vec<u8>,
    pub(crate) truncated: bool,
    pub(crate) running: bool,
    pub(crate) exit_code: Option<u32>,
    pub(crate) read_closed: bool,
    pub(crate) read_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RuntimeError {
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
pub(crate) struct SessionRuntime {
    sessions: Mutex<HashMap<String, Arc<SessionProcess>>>,
    next_run_id: Mutex<u64>,
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

#[derive(Debug, Default)]
pub(crate) struct CursorPositionQueryDetector {
    matched: usize,
}

impl CursorPositionQueryDetector {
    pub(crate) fn observe(&mut self, bytes: &[u8]) -> usize {
        let mut query_count = 0;
        for byte in bytes {
            if *byte == CURSOR_POSITION_QUERY[self.matched] {
                self.matched += 1;
                if self.matched == CURSOR_POSITION_QUERY.len() {
                    query_count += 1;
                    self.matched = 0;
                }
            } else {
                self.matched = usize::from(*byte == CURSOR_POSITION_QUERY[0]);
            }
        }
        query_count
    }
}

#[derive(Debug, Default)]
pub(crate) struct OutputBuffer {
    start: u64,
    next: u64,
    bytes: VecDeque<u8>,
}

impl SessionRuntime {
    pub(crate) fn spawn(
        &self,
        request: SpawnSessionRequest,
    ) -> Result<SessionSnapshot, RuntimeError> {
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
        if let Err(error) = spawn_reader_thread(
            request.session_id.clone(),
            reader,
            Arc::clone(&output),
            Arc::clone(&status),
            Arc::clone(&writer),
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

    pub(crate) fn snapshot(
        &self,
        request: SessionIdRequest,
    ) -> Result<Option<SessionSnapshot>, RuntimeError> {
        let process = {
            let sessions = lock(&self.sessions, "session registry")?;
            sessions.get(&request.session_id).cloned()
        };
        process.map(|session| session.snapshot()).transpose()
    }

    pub(crate) fn read(&self, request: ReadSessionRequest) -> Result<SessionRead, RuntimeError> {
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

    pub(crate) fn write(&self, request: WriteSessionRequest) -> Result<(), RuntimeError> {
        let process = self.session(&request.session_id)?;
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

    pub(crate) fn resize(&self, request: ResizeSessionRequest) -> Result<(), RuntimeError> {
        validate_size(request.cols, request.rows)?;
        let process = self.session(&request.session_id)?;
        let master = lock(&process.master, "PTY master")?;
        let master = master
            .as_ref()
            .ok_or_else(|| RuntimeError::Process("PTY is closed".into()))?;
        master
            .resize(pty_size(request.cols, request.rows))
            .map_err(|error| RuntimeError::Process(error.to_string()))
    }

    pub(crate) fn kill(&self, request: SessionIdRequest) -> Result<SessionSnapshot, RuntimeError> {
        let process = self.session(&request.session_id)?;
        lock(&process.child, "child process")?
            .kill()
            .map_err(|error| RuntimeError::Process(error.to_string()))?;
        lock(&process.status, "process status")?.running = false;
        process.close_pty()?;
        process.snapshot()
    }

    pub(crate) fn discard(&self, request: SessionIdRequest) -> Result<(), RuntimeError> {
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
        drop(lock(&self.master, "PTY master")?.take());
        Ok(())
    }

    fn refresh_status(&self) -> Result<(), RuntimeError> {
        let exit = lock(&self.child, "child process")?
            .try_wait()
            .map_err(|error| RuntimeError::Process(error.to_string()))?;
        if let Some(exit) = exit {
            let mut status = lock(&self.status, "process status")?;
            status.running = false;
            status.exit_code = Some(exit.exit_code());
        }
        Ok(())
    }

    fn snapshot(&self) -> Result<SessionSnapshot, RuntimeError> {
        self.refresh_status()?;
        let status = lock(&self.status, "process status")?;
        Ok(SessionSnapshot {
            session_id: self.id.clone(),
            run_id: self.run_id,
            process_id: self.process_id,
            running: status.running,
            exit_code: status.exit_code,
            read_closed: status.read_closed,
            read_error: status.read_error.clone(),
        })
    }
}

impl Drop for SessionProcess {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
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
    pub(crate) fn append(&mut self, chunk: &[u8]) {
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
    pub(crate) fn read_for_test(&self, after: u64) -> TestOutputRead {
        let read = self.read(after);
        TestOutputRead {
            start: read.start,
            truncated: read.truncated,
        }
    }
}

#[cfg(test)]
pub(crate) struct TestOutputRead {
    pub(crate) start: u64,
    pub(crate) truncated: bool,
}

fn spawn_reader_thread(
    session_id: String,
    mut reader: Box<dyn Read + Send>,
    output: Arc<Mutex<OutputBuffer>>,
    status: Arc<Mutex<ProcessStatus>>,
    writer: Arc<Mutex<Option<Box<dyn Write + Send>>>>,
) -> Result<(), RuntimeError> {
    thread::Builder::new()
        .name(format!("talkak-pty-reader-{session_id}"))
        .spawn(move || {
            let mut chunk = [0_u8; 8192];
            let mut cursor_query = CursorPositionQueryDetector::default();
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(read) => {
                        for _ in 0..cursor_query.observe(&chunk[..read]) {
                            if let Ok(mut current_writer) = writer.lock() {
                                if let Some(current_writer) = current_writer.as_mut() {
                                    let _ = current_writer.write_all(CURSOR_POSITION_REPORT);
                                    let _ = current_writer.flush();
                                }
                            }
                        }
                        if let Ok(mut buffer) = output.lock() {
                            buffer.append(&chunk[..read]);
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

fn command_for_request(request: &SpawnSessionRequest) -> CommandBuilder {
    let mut command = match request.command.as_deref() {
        Some(program) => CommandBuilder::new(program),
        None => CommandBuilder::new_default_prog(),
    };
    command.args(&request.args);
    if let Some(cwd) = request.cwd.as_deref() {
        command.cwd(cwd);
    }
    command
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn lock<'a, T>(mutex: &'a Mutex<T>, name: &str) -> Result<MutexGuard<'a, T>, RuntimeError> {
    mutex
        .lock()
        .map_err(|_| RuntimeError::Internal(format!("{name} lock was poisoned")))
}
