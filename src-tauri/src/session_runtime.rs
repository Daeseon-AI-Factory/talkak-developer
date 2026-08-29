//! Client for the detached session broker.
//!
//! The engine that used to live here (PTY runtime + on-disk store) now runs inside
//! `talkak-dev-broker`, a detached process that outlives this app — that is what lets a terminal
//! session, and the agent working in it, survive an app restart or reinstall. This module keeps
//! the exact same ten call signatures and forwards them over a local transport (unix socket /
//! named pipe) as newline-delimited JSON in strict request→response lockstep, so
//! `session_commands.rs` and the renderer are unchanged.

pub(crate) use session_broker::runtime::{
    LiveSession, ReadSessionRequest, ResizeSessionRequest, RunSessionRequest, SessionIdRequest,
    SessionRead, SessionSnapshot, SpawnSessionRequest, WriteSessionRequest,
};
pub(crate) use session_broker::store::RestorableSession;
use session_broker::{Request, Response, PROTOCOL_VERSION};
use std::fmt;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex};
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

/// Connection ceiling once the broker says it serves clients concurrently — enough for every
/// visible pane's poll plus keystrokes, without growing unbounded.
const MAX_CONNECTIONS: usize = 8;

/// How long a caller waits for a free connection before being told the pool is stuck. Long enough
/// that ordinary contention never trips it, short enough that a wedged request cannot pass for a
/// hung application.
const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(10);

/// How long one request waits for its answer. A spawn does openpty plus CreateProcess and a
/// StoredOutput reads a whole retained log, so this is generous; it exists to bound a broker that
/// has stopped answering at all, not to police normal latency.
const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(20);

/// A bounded connection pool. The limit starts at ONE and only opens up when a broker's handshake
/// says it serves connections concurrently: a broker predating that fix answers one client at a
/// time, so a second connection to it would wait forever. Requests beyond the limit wait for a
/// connection to come back rather than opening one that cannot be served.
struct Pool {
    idle: Vec<Connection>,
    outstanding: usize,
    limit: usize,
}

pub(crate) struct SessionRuntime {
    endpoint: String,
    store_dir: Option<PathBuf>,
    data_dir: Option<PathBuf>,
    /// A POOL, not one connection: the protocol is lockstep per connection, so a single shared one
    /// made every pane's poll and every keystroke queue single-file — a keystroke's write waited
    /// out whatever read was in flight. Each request checks a connection out exclusively.
    pool: Mutex<Pool>,
    available: Condvar,
    /// Serialises broker startup so a burst of first requests spawns one broker, not eight.
    launch: Mutex<()>,
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
            pool: Mutex::new(Pool {
                idle: Vec::new(),
                outstanding: 0,
                limit: 1,
            }),
            available: Condvar::new(),
            launch: Mutex::new(()),
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
            Response::Snapshot(snapshot) => {
                sweep_process_tree(snapshot.process_id);
                Ok(snapshot)
            }
            other => Err(unexpected(other)),
        }
    }

    pub(crate) fn discard(&self, request: SessionIdRequest) -> BrokerResult<()> {
        match self.request(&Request::Discard(request))? {
            Response::Unit => Ok(()),
            other => Err(unexpected(other)),
        }
    }

    /// Every session the broker holds, so an operator can find and stop shells that outlived
    /// their panes. The error is RETURNED, not swallowed: a broker too old to know this request
    /// answers with one, and an empty list would claim there is nothing to clean up when there
    /// may be dozens.
    pub(crate) fn live_sessions(&self) -> BrokerResult<Vec<LiveSession>> {
        match self.request(&Request::Sessions)? {
            Response::Sessions(sessions) => Ok(sessions),
            other => Err(unexpected(other)),
        }
    }

    /// What a restart could bring back. The error is RETURNED: an empty list here reads as "there
    /// is nothing to recover", and this app has already shipped that exact lie twice — a refused
    /// clipboard that looked like a successful copy, and a broker error that became an empty
    /// session list while twenty-two shells ran.
    pub(crate) fn restorable(&self) -> BrokerResult<Vec<RestorableSession>> {
        match self.request(&Request::Restorable)? {
            Response::Restorable(sessions) => Ok(sessions),
            other => Err(unexpected(other)),
        }
    }

    /// The retained tail for a session. Empty bytes and an unreachable broker are different facts:
    /// the caller offers a relaunch that discards this output, so "I could not read it" must not
    /// arrive as "there was nothing to read".
    pub(crate) fn stored_output(&self, session_id: &str) -> BrokerResult<Vec<u8>> {
        let request = Request::StoredOutput(SessionIdRequest {
            session_id: session_id.to_owned(),
        });
        match self.request(&request)? {
            Response::Bytes(bytes) => Ok(bytes),
            other => Err(unexpected(other)),
        }
    }

    pub(crate) fn persists(&self) -> BrokerResult<bool> {
        match self.request(&Request::Persists)? {
            Response::Persists(persists) => Ok(persists),
            other => Err(unexpected(other)),
        }
    }

    /// One lockstep exchange on a connection checked out of the pool. A broken connection is
    /// dropped and retried once — the broker may have exited while idle, which is its normal life
    /// cycle, not a failure.
    fn request(&self, request: &Request) -> BrokerResult<Response> {
        for attempt in 0..2 {
            let connection = self.acquire()?;
            match exchange_within(connection, request, EXCHANGE_TIMEOUT) {
                Exchanged::Answered(connection, Response::Error { message }) => {
                    self.release(connection);
                    return Err(BrokerError(message));
                }
                Exchanged::Answered(connection, response) => {
                    self.release(connection);
                    return Ok(response);
                }
                // A failed exchange leaves the connection's framing unknown: drop it, never pool it.
                Exchanged::Failed(error) => {
                    self.release_slot();
                    if attempt == 1 {
                        return Err(BrokerError(format!("broker connection failed: {error}")));
                    }
                }
                // Abandoned, not retried: the request may well have been carried out, so sending it
                // again could spawn a second shell or write input twice.
                Exchanged::TimedOut => {
                    self.release_slot();
                    return Err(BrokerError(
                        "the session broker did not answer in time".into(),
                    ));
                }
            }
        }
        unreachable!("both attempts return");
    }

    /// A pooled connection, a new one, or a wait until one frees up — never a connection beyond
    /// what the broker on the other end can actually serve.
    fn acquire(&self) -> BrokerResult<Connection> {
        let mut pool = self
            .pool
            .lock()
            .map_err(|_| BrokerError("broker pool lock poisoned".into()))?;
        loop {
            if let Some(connection) = pool.idle.pop() {
                pool.outstanding += 1;
                return Ok(connection);
            }
            if pool.outstanding < pool.limit {
                pool.outstanding += 1;
                drop(pool);
                return self.establish().inspect_err(|_| self.release_slot());
            }
            // Bounded. A request that never comes back is abandoned by `exchange_within` but its
            // slot is only freed after the timeout, and waiting here forever meant every other
            // pane's thread parked on this Condvar behind it. Failing says so instead.
            let (guard, wait) = self
                .available
                .wait_timeout(pool, ACQUIRE_TIMEOUT)
                .map_err(|_| BrokerError("broker pool lock poisoned".into()))?;
            pool = guard;
            if wait.timed_out() && pool.idle.is_empty() && pool.outstanding >= pool.limit {
                return Err(BrokerError(
                    "every broker connection is busy — a previous command has not come back".into(),
                ));
            }
        }
    }

    fn release(&self, connection: Connection) {
        if let Ok(mut pool) = self.pool.lock() {
            pool.outstanding -= 1;
            if pool.idle.len() < MAX_CONNECTIONS {
                pool.idle.push(connection);
            }
        }
        self.available.notify_one();
    }

    /// Give a slot back without pooling the connection — its framing is unknown after a failure.
    fn release_slot(&self) {
        if let Ok(mut pool) = self.pool.lock() {
            pool.outstanding = pool.outstanding.saturating_sub(1);
        }
        self.available.notify_one();
    }

    #[cfg(test)]
    pub(crate) fn connection_limit(&self) -> usize {
        self.pool.lock().map(|pool| pool.limit).unwrap_or(0)
    }

    /// Raised only by a broker that says it serves clients concurrently.
    fn allow_concurrent_connections(&self) {
        if let Ok(mut pool) = self.pool.lock() {
            if pool.limit < MAX_CONNECTIONS {
                pool.limit = MAX_CONNECTIONS;
            }
        }
        self.available.notify_all();
    }

    /// Connect to a live broker or start one, then verify the protocol. A stale broker from an
    /// older app version is asked to shut down and replaced.
    fn establish(&self) -> BrokerResult<Connection> {
        for _ in 0..2 {
            let mut connection = match connect(&self.endpoint) {
                Ok(connection) => connection,
                Err(_) => {
                    // Under the launch lock, re-probe first: a concurrent caller may have started
                    // the broker while this one waited, and two brokers would split the sessions.
                    let _guard = self
                        .launch
                        .lock()
                        .map_err(|_| BrokerError("broker launch lock poisoned".into()))?;
                    match connect(&self.endpoint) {
                        Ok(connection) => connection,
                        Err(_) => {
                            self.launch_broker()?;
                            wait_for_endpoint(&self.endpoint, Duration::from_secs(5))?
                        }
                    }
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
                    protocol_version,
                    concurrent,
                    ..
                } if protocol_version == PROTOCOL_VERSION => {
                    if concurrent {
                        self.allow_concurrent_connections();
                    }
                    return Ok(connection);
                }
                Response::Hello { .. } => {
                    // Retire the stale broker; live sessions under an old protocol cannot be
                    // spoken to correctly anyway. The next loop iteration starts a fresh one.
                    let _ = exchange(&mut connection, &Request::Shutdown);
                    drop(connection);
                    // Wait for it to actually let go of the endpoint. A fixed sleep raced a broker
                    // holding dozens of sessions: the retry connected to the dying one, saw the
                    // same old version, and the whole launch failed instead of replacing it.
                    wait_for_endpoint_gone(&self.endpoint, Duration::from_secs(5));
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
        let source_bytes = std::fs::read(source).ok()?;
        // The name carries a digest of the binary, not just the version: during development the
        // version does not move, and a same-named copy locked by a running broker silently pinned
        // every later build to the first day's binary.
        //
        // It used to carry the byte LENGTH, which made the freshness check below tautological — the
        // length was already in the path, so `meta.len() == source_len` was true of any complete
        // file there and could only fail if it was missing or truncated. Any rebuild that did not
        // change the size went unnoticed, and plenty do not: retuning a constant, flipping `>` to
        // `>=`, editing a log string to another of the same length. The developer then ran
        // yesterday's broker with nothing to indicate it.
        let file_name = format!(
            "talkak-dev-broker-{}-{}{}",
            env!("CARGO_PKG_VERSION"),
            digest(&source_bytes),
            std::env::consts::EXE_SUFFIX
        );
        let destination = broker_dir.join(file_name);
        // Now that the name IS the content, existence is the whole check.
        if !destination.exists() {
            // A locked destination means a broker built from these exact bytes is already running
            // from it; using it as-is is the intended outcome, not an error.
            if std::fs::copy(source, &destination).is_err() && !destination.exists() {
                return None;
            }
        }
        prune_superseded_brokers(&broker_dir, &destination);
        Some(destination)
    }
}

/// A stable name for a binary's contents. Not cryptographic — it only has to change when the bytes
/// change, and `DefaultHasher` is fixed-key, so a given build always resolves to the same name.
fn digest(bytes: &[u8]) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// Every build leaves another megabyte behind, so old copies are swept as new ones land. A binary a
/// broker is still executing is locked and simply refuses to go, which is exactly right: that
/// broker is still holding someone's sessions.
fn prune_superseded_brokers(broker_dir: &Path, keep: &Path) {
    let Ok(entries) = std::fs::read_dir(broker_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path == keep {
            continue;
        }
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("talkak-dev-broker-"))
        {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Stopping a session kills the shell, but on Windows the shell's children — an agent CLI mid-run —
/// survive it and keep working blind, holding their session files open (a later `codex resume`
/// then fails on "already has an active writer"). Sweep the whole tree, best-effort: by the time
/// this runs the engine has already killed the shell itself.
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

fn unexpected(response: Response) -> BrokerError {
    BrokerError(format!("unexpected broker response: {response:?}"))
}

/// The outcome of one bounded request/response turn.
enum Exchanged {
    Answered(Connection, Response),
    Failed(std::io::Error),
    TimedOut,
}

/// One exchange, on a thread, with a deadline.
///
/// `open_stream` can only set a read timeout under cfg(unix) — on Windows the pipe is a plain
/// `File` and a blocking read has no bound at all, so a broker that never answers held its caller
/// forever and its pool slot with it. Doing the turn on a thread lets the caller give up while the
/// read stays where it is: the connection travels WITH the thread and is dropped there whenever the
/// broker finally replies or the pipe closes, so nothing half-read is ever returned to the pool.
fn exchange_within(
    mut connection: Connection,
    request: &Request,
    timeout: Duration,
) -> Exchanged {
    let (sender, receiver) = std::sync::mpsc::channel();
    let encoded = match serde_json::to_vec(request) {
        Ok(encoded) => encoded,
        Err(error) => return Exchanged::Failed(std::io::Error::other(error)),
    };
    let worker = std::thread::Builder::new()
        .name("talkak-broker-exchange".into())
        .spawn(move || {
            let outcome = exchange_encoded(&mut connection, &encoded);
            // If the caller has already given up the send fails, and the connection drops here.
            let _ = sender.send(outcome.map(|response| (connection, response)));
        });
    if let Err(error) = worker {
        return Exchanged::Failed(error);
    }
    match receiver.recv_timeout(timeout) {
        Ok(Ok((connection, response))) => Exchanged::Answered(connection, response),
        Ok(Err(error)) => Exchanged::Failed(error),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Exchanged::TimedOut,
        // The worker died without sending — treat it as a dead connection, not a timeout.
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Exchanged::Failed(
            std::io::Error::new(std::io::ErrorKind::BrokenPipe, "broker exchange thread ended"),
        ),
    }
}

fn exchange_encoded(connection: &mut Connection, encoded: &[u8]) -> std::io::Result<Response> {
    let mut line = encoded.to_vec();
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

/// Wait until nothing answers on the endpoint, so a replacement broker can take it. Returns on
/// timeout rather than failing: the caller's next connect attempt is the real verdict.
fn wait_for_endpoint_gone(endpoint: &str, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while connect(endpoint).is_ok() {
        if Instant::now() >= deadline {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
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
