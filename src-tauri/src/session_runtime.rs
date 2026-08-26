//! Client for the detached session broker.
//!
//! The engine that used to live here (PTY runtime + on-disk store) now runs inside
//! `talkak-dev-broker`, a detached process that outlives this app — that is what lets a terminal
//! session, and the agent working in it, survive an app restart or reinstall. This module keeps
//! the exact same ten call signatures and forwards them over a local transport (unix socket /
//! named pipe) as newline-delimited JSON in strict request→response lockstep, so
//! `session_commands.rs` and the renderer are unchanged.

pub(crate) use session_broker::runtime::{
    ReadSessionRequest, ResizeSessionRequest, RunSessionRequest, SessionIdRequest, SessionRead,
    SessionSnapshot, SpawnSessionRequest, WriteSessionRequest,
};
pub(crate) use session_broker::store::RestorableSession;
use session_broker::{Request, Response, PROTOCOL_VERSION};
use std::fmt;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Broker errors surface as their message: the engine already prefixes them
/// ("invalid session request: …", "session process error: …") and the renderer shows the text.
#[derive(Debug)]
pub(crate) struct BrokerError(String);

impl fmt::Display for BrokerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.0)
    }
}

impl std::error::Error for BrokerError {}

type BrokerResult<T> = Result<T, BrokerError>;

#[cfg(unix)]
type Stream = std::os::unix::net::UnixStream;
#[cfg(windows)]
type Stream = std::fs::File;

struct Connection {
    writer: Stream,
    reader: BufReader<Stream>,
}

pub(crate) struct SessionRuntime {
    endpoint: String,
    store_dir: Option<PathBuf>,
    data_dir: Option<PathBuf>,
    connection: Mutex<Option<Connection>>,
}

impl SessionRuntime {
    /// A client bound to this app's data directory: the broker writes session records to the same
    /// `sessions` store the app used when the engine was in-process, so nothing already recorded
    /// is lost across this migration.
    pub(crate) fn attach(data_dir: Option<PathBuf>) -> Self {
        Self::at_endpoint(default_endpoint(), data_dir)
    }

    /// Tests bind their own endpoint so they never adopt — or disturb — the user's real broker.
    pub(crate) fn at_endpoint(endpoint: String, data_dir: Option<PathBuf>) -> Self {
        Self {
            endpoint,
            store_dir: data_dir.as_ref().map(|dir| dir.join("sessions")),
            data_dir,
            connection: Mutex::new(None),
        }
    }

    pub(crate) fn spawn(&self, request: SpawnSessionRequest) -> BrokerResult<SessionSnapshot> {
        match self.request(&Request::Spawn(request))? {
            Response::Snapshot(snapshot) => Ok(snapshot),
            other => Err(unexpected(other)),
        }
    }

    pub(crate) fn snapshot(
        &self,
        request: SessionIdRequest,
    ) -> BrokerResult<Option<SessionSnapshot>> {
        match self.request(&Request::Snapshot(request))? {
            Response::MaybeSnapshot(snapshot) => Ok(snapshot),
            other => Err(unexpected(other)),
        }
    }

    pub(crate) fn read(&self, request: ReadSessionRequest) -> BrokerResult<SessionRead> {
        match self.request(&Request::Read(request))? {
            Response::Read(read) => Ok(read),
            other => Err(unexpected(other)),
        }
    }

    pub(crate) fn write(&self, request: WriteSessionRequest) -> BrokerResult<()> {
        match self.request(&Request::Write(request))? {
            Response::Unit => Ok(()),
            other => Err(unexpected(other)),
        }
    }

    pub(crate) fn resize(&self, request: ResizeSessionRequest) -> BrokerResult<()> {
        match self.request(&Request::Resize(request))? {
            Response::Unit => Ok(()),
            other => Err(unexpected(other)),
        }
    }

    pub(crate) fn kill(&self, request: RunSessionRequest) -> BrokerResult<SessionSnapshot> {
        match self.request(&Request::Kill(request))? {
            Response::Snapshot(snapshot) => Ok(snapshot),
            other => Err(unexpected(other)),
        }
    }

    pub(crate) fn discard(&self, request: SessionIdRequest) -> BrokerResult<()> {
        match self.request(&Request::Discard(request))? {
            Response::Unit => Ok(()),
            other => Err(unexpected(other)),
        }
    }

    /// Errors read as an empty restore list: the workspace can still open, and `persists()`
    /// reports the store state honestly on its own.
    pub(crate) fn restorable(&self) -> Vec<RestorableSession> {
        match self.request(&Request::Restorable) {
            Ok(Response::Restorable(sessions)) => sessions,
            _ => Vec::new(),
        }
    }

    pub(crate) fn stored_output(&self, session_id: &str) -> Vec<u8> {
        let request = Request::StoredOutput(SessionIdRequest {
            session_id: session_id.to_owned(),
        });
        match self.request(&request) {
            Ok(Response::Bytes(bytes)) => bytes,
            _ => Vec::new(),
        }
    }

    pub(crate) fn persists(&self) -> bool {
        match self.request(&Request::Persists) {
            Ok(Response::Persists(persists)) => persists,
            _ => false,
        }
    }

    /// One lockstep exchange. A broken connection is re-established once — the broker may have
    /// exited while idle, which is its normal life cycle, not a failure.
    fn request(&self, request: &Request) -> BrokerResult<Response> {
        let mut guard = self
            .connection
            .lock()
            .map_err(|_| BrokerError("broker connection lock poisoned".into()))?;
        for attempt in 0..2 {
            if guard.is_none() {
                *guard = Some(self.establish()?);
            }
            let connection = guard.as_mut().expect("connection just established");
            match exchange(connection, request) {
                Ok(Response::Error { message }) => return Err(BrokerError(message)),
                Ok(response) => return Ok(response),
                Err(error) => {
                    *guard = None;
                    if attempt == 1 {
                        return Err(BrokerError(format!("broker connection failed: {error}")));
                    }
                }
            }
        }
        unreachable!("both attempts return");
    }

    /// Connect to a live broker or start one, then verify the protocol. A stale broker from an
    /// older app version is asked to shut down and replaced.
    fn establish(&self) -> BrokerResult<Connection> {
        for _ in 0..2 {
            let mut connection = match connect(&self.endpoint) {
                Ok(connection) => connection,
                Err(_) => {
                    self.launch_broker()?;
                    wait_for_endpoint(&self.endpoint, Duration::from_secs(5))?
                }
            };
            let hello = exchange(
                &mut connection,
                &Request::Hello {
                    protocol_version: PROTOCOL_VERSION,
                },
            )
            .map_err(|error| BrokerError(format!("broker handshake failed: {error}")))?;
            match hello {
                Response::Hello {
                    protocol_version, ..
                } if protocol_version == PROTOCOL_VERSION => return Ok(connection),
                Response::Hello { .. } => {
                    // Retire the stale broker; live sessions under an old protocol cannot be
                    // spoken to correctly anyway. The next loop iteration starts a fresh one.
                    let _ = exchange(&mut connection, &Request::Shutdown);
                    drop(connection);
                    std::thread::sleep(Duration::from_millis(200));
                }
                other => return Err(unexpected(other)),
            }
        }
        Err(BrokerError(
            "broker kept answering with an incompatible protocol".into(),
        ))
    }

    fn launch_broker(&self) -> BrokerResult<()> {
        let source = broker_binary()?;
        let program = self.installable_copy(&source).unwrap_or(source);
        let store = self
            .store_dir
            .as_ref()
            .map(|dir| dir.to_string_lossy().into_owned());
        let mut arguments = vec![self.endpoint.as_str()];
        if let Some(store) = store.as_deref() {
            arguments.push(store);
        }
        session_broker::spawn_detached(&program.to_string_lossy(), &arguments)
            .map_err(|error| BrokerError(format!("failed to start the session broker: {error}")))?;
        Ok(())
    }

    /// Run the broker from a copy under the app's data directory, not from the install directory:
    /// a running broker holds a lock on its own executable on Windows, and it must survive the
    /// very reinstall that wants to replace that directory.
    fn installable_copy(&self, source: &Path) -> Option<PathBuf> {
        let data_dir = self.data_dir.as_ref()?;
        let broker_dir = data_dir.join("broker");
        std::fs::create_dir_all(&broker_dir).ok()?;
        let file_name = format!(
            "talkak-dev-broker-{}{}",
            env!("CARGO_PKG_VERSION"),
            std::env::consts::EXE_SUFFIX
        );
        let destination = broker_dir.join(file_name);
        let source_len = std::fs::metadata(source).ok()?.len();
        let up_to_date = std::fs::metadata(&destination)
            .map(|meta| meta.len() == source_len)
            .unwrap_or(false);
        if !up_to_date {
            // A locked destination means a broker of this exact version is already running from
            // it; using it as-is is the intended outcome, not an error.
            if std::fs::copy(source, &destination).is_err() && !destination.exists() {
                return None;
            }
        }
        Some(destination)
    }
}

fn unexpected(response: Response) -> BrokerError {
    BrokerError(format!("unexpected broker response: {response:?}"))
}

fn exchange(connection: &mut Connection, request: &Request) -> std::io::Result<Response> {
    let mut line = serde_json::to_vec(request)?;
    line.push(b'\n');
    connection.writer.write_all(&line)?;
    connection.writer.flush()?;
    let mut reply = String::new();
    let read = connection.reader.read_line(&mut reply)?;
    if read == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "broker closed the connection",
        ));
    }
    serde_json::from_str(&reply).map_err(std::io::Error::other)
}

fn connect(endpoint: &str) -> std::io::Result<Connection> {
    let stream = open_stream(endpoint)?;
    let reader = BufReader::new(clone_stream(&stream)?);
    Ok(Connection {
        writer: stream,
        reader,
    })
}

#[cfg(unix)]
fn open_stream(endpoint: &str) -> std::io::Result<Stream> {
    let stream = Stream::connect(endpoint)?;
    // A wedged broker must fail a command, not hang the app forever.
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    Ok(stream)
}

#[cfg(windows)]
fn open_stream(endpoint: &str) -> std::io::Result<Stream> {
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(endpoint)
}

#[cfg(unix)]
fn clone_stream(stream: &Stream) -> std::io::Result<Stream> {
    stream.try_clone()
}

#[cfg(windows)]
fn clone_stream(stream: &Stream) -> std::io::Result<Stream> {
    stream.try_clone()
}

fn wait_for_endpoint(endpoint: &str, timeout: Duration) -> BrokerResult<Connection> {
    let deadline = Instant::now() + timeout;
    loop {
        match connect(endpoint) {
            Ok(connection) => return Ok(connection),
            Err(error) => {
                if Instant::now() >= deadline {
                    return Err(BrokerError(format!(
                        "the session broker did not come up in time: {error}"
                    )));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
}

/// Same per-user endpoint the broker derives for itself, kept in one place on each side.
fn default_endpoint() -> String {
    #[cfg(unix)]
    {
        let base = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        #[cfg(target_os = "macos")]
        let base = format!("{base}/Library/Application Support");
        #[cfg(not(target_os = "macos"))]
        let base =
            std::env::var("XDG_DATA_HOME").unwrap_or_else(|_| format!("{base}/.local/share"));
        format!("{base}/TalkakDev/broker/broker.sock")
    }
    #[cfg(windows)]
    {
        let user = std::env::var("USERNAME").unwrap_or_else(|_| "default".to_string());
        format!(r"\\.\pipe\talkak-dev-broker-{user}")
    }
}

/// The broker binary: beside this executable in an installed app (Tauri sidecar), or in the
/// broker crate's own target directory during development and `cargo test`.
fn broker_binary() -> BrokerResult<PathBuf> {
    let name = format!("talkak-dev-broker{}", std::env::consts::EXE_SUFFIX);
    if let Ok(current) = std::env::current_exe() {
        if let Some(dir) = current.parent() {
            let sibling = dir.join(&name);
            if sibling.is_file() {
                return Ok(sibling);
            }
        }
    }
    let crate_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    for profile in ["debug", "release"] {
        let dev = crate_dir
            .join("../session-broker/target")
            .join(profile)
            .join(&name);
        if dev.is_file() {
            return Ok(dev);
        }
    }
    Err(BrokerError(
        "session broker binary not found — build it with `cargo build` in session-broker/".into(),
    ))
}
