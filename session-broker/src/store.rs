//! Bounded on-disk session evidence reserved for a future machine-restart workflow.
//!
//! The current product reattaches only sessions still owned by its live broker. These records are
//! not exposed as a finished recovery feature; keeping them bounded preserves the raw material
//! without making a promise the UI cannot fulfil.
//!
//! Both platforms use the same layout under one caller-supplied root. Session ids are hex-encoded
//! into file names so an id containing a path separator, a `..`, or a Windows reserved device name
//! (CON, NUL, COM1 …) can never escape or collide with the store directory.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex, PoisonError};
use std::thread;

use crate::runtime::RuntimeError;

/// Exact internal storage limits, not product promises.
const MAX_LOG_BYTES: u64 = 8 * 1024 * 1024;
/// How much of the tail survives a rotation. Keeping half amortises the rewrite cost.
const LOG_RETAINED_BYTES: u64 = 2 * 1024 * 1024;
/// Chunks a session's log writer may have queued before the reader thread starts dropping them.
/// PTY reads are at most 8 KiB, so this is a few megabytes of disk lag — far more than a healthy
/// disk ever accumulates, and the live terminal must never wait for a sick one.
const LOG_QUEUE_CHUNKS: usize = 512;

const DEFINITION_EXTENSION: &str = "json";
const OUTPUT_EXTENSION: &str = "log";

/// Stored session definition and start time; currently internal persistence evidence only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSession {
    pub session_id: String,
    /// The broker-owned run identity. Older installed records do not carry it, so `None` remains
    /// a valid compatibility value until that session is spawned again and atomically replaced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<u64>,
    pub cwd: Option<String>,
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    pub cols: u16,
    pub rows: u16,
    /// Milliseconds since the Unix epoch. Numeric so ordering never depends on a date format, and
    /// so recording a session needs no date library in the backend.
    pub started_at_ms: u64,
}

/// Wall-clock milliseconds, or 0 if the host clock is before the epoch.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

/// A stored session record plus the size of its retained output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorableSession {
    #[serde(flatten)]
    pub session: StoredSession,
    pub output_bytes: u64,
}

/// Writes session records under a root directory. A store with no root keeps nothing, which is what
/// tests and non-desktop hosts want — every method stays a no-op rather than a special case.
#[derive(Debug, Default)]
pub struct SessionStore {
    root: Option<PathBuf>,
    /// One writer thread per session with an open output log. `append_output` runs on the PTY
    /// reader thread for every chunk the shell produces; it hands the chunk to the writer and
    /// returns. The disk — its write, and the occasional rotation that rewrites two megabytes —
    /// is the writer's problem, never the terminal's.
    writers: Mutex<HashMap<String, LogWriter>>,
}

#[derive(Debug)]
struct LogWriter {
    sender: mpsc::SyncSender<LogMessage>,
    thread: Option<thread::JoinHandle<()>>,
}

#[derive(Debug)]
enum LogMessage {
    Chunk(Vec<u8>),
    /// Answered once every chunk queued before it is in the file.
    Flush(mpsc::SyncSender<()>),
    Close,
}

impl LogWriter {
    fn start(session_id: &str, path: PathBuf) -> Option<Self> {
        let (sender, receiver) = mpsc::sync_channel(LOG_QUEUE_CHUNKS);
        let thread = thread::Builder::new()
            .name(format!("talkak-log-writer-{session_id}"))
            .spawn(move || write_log(&path, receiver))
            .ok()?;
        Some(Self {
            sender,
            thread: Some(thread),
        })
    }

    /// Queue a chunk without waiting. A full queue drops it: the log is evidence, and evidence
    /// that costs the live terminal a stall is not worth keeping. `false` means the writer is gone.
    fn offer(&self, chunk: &[u8]) -> bool {
        match self.sender.try_send(LogMessage::Chunk(chunk.to_vec())) {
            Ok(()) | Err(mpsc::TrySendError::Full(_)) => true,
            Err(mpsc::TrySendError::Disconnected(_)) => false,
        }
    }

    /// Block until everything queued so far is in the file.
    fn flush(sender: &mpsc::SyncSender<LogMessage>) {
        let (ack, done) = mpsc::sync_channel(1);
        if sender.send(LogMessage::Flush(ack)).is_ok() {
            let _ = done.recv();
        }
    }

    /// Drain, close the file, and wait for the thread — so the file can be deleted afterwards
    /// even on Windows, which refuses to remove a file something still has open.
    fn close(mut self) {
        let _ = self.sender.send(LogMessage::Close);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// The writer thread: owns the file handle and the byte count, and rotates in place.
fn write_log(path: &Path, receiver: mpsc::Receiver<LogMessage>) {
    let Some((mut file, mut bytes)) = open_log(path) else {
        return;
    };
    while let Ok(message) = receiver.recv() {
        match message {
            LogMessage::Chunk(chunk) => {
                if file.write_all(&chunk).is_err() {
                    // The handle is no longer trustworthy. Leaving makes the next chunk start a
                    // fresh writer over a freshly opened file.
                    return;
                }
                bytes += chunk.len() as u64;
                if bytes > MAX_LOG_BYTES {
                    // Rotation rewrites the file under a new inode; the handle goes with it.
                    drop(file);
                    rotate(path);
                    match open_log(path) {
                        Some((reopened, size)) => {
                            file = reopened;
                            bytes = size;
                        }
                        None => return,
                    }
                }
            }
            LogMessage::Flush(ack) => {
                let _ = file.flush();
                let _ = ack.send(());
            }
            LogMessage::Close => return,
        }
    }
}

fn open_log(path: &Path) -> Option<(fs::File, u64)> {
    let file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .ok()?;
    let bytes = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    Some((file, bytes))
}

impl SessionStore {
    /// Create the store directory eagerly so a permission problem surfaces at startup, not on the
    /// first spawn. A root that cannot be created disables persistence instead of failing the app.
    pub fn at(root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        match fs::create_dir_all(&root) {
            Ok(()) => Self {
                root: Some(root),
                writers: Mutex::default(),
            },
            Err(_) => Self::default(),
        }
    }

    pub fn enabled(&self) -> bool {
        self.root.is_some()
    }

    /// Record a session definition. A new run of the same id replaces its previous internal record.
    pub fn record(&self, session: &StoredSession) -> Result<(), RuntimeError> {
        let Some(root) = self.root.as_deref() else {
            return Ok(());
        };
        let encoded = serde_json::to_vec(session)
            .map_err(|error| RuntimeError::Internal(format!("encode session record: {error}")))?;
        let path = entry_path(root, &session.session_id, DEFINITION_EXTENSION);
        write_atomically(&path, &encoded)
            .map_err(|error| RuntimeError::Internal(format!("write session record: {error}")))?;
        // A fresh run must not inherit the previous run's output — nor its open handle.
        self.close_log(&session.session_id);
        let _ = fs::remove_file(entry_path(root, &session.session_id, OUTPUT_EXTENSION));
        Ok(())
    }

    /// Stop a session's writer and wait for it to let go of the file.
    fn close_log(&self, session_id: &str) {
        let writer = self
            .writers
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(session_id);
        // Joined outside the lock: the reader thread must not queue behind a slow disk.
        if let Some(writer) = writer {
            writer.close();
        }
    }

    /// Append output for a session. Never blocks on the disk and never fails loudly: the chunk is
    /// handed to the session's writer thread, and a chunk that cannot be queued is dropped — losing
    /// a log line must never break the live terminal, and the reader thread has no channel to
    /// report on.
    pub fn append_output(&self, session_id: &str, bytes: &[u8]) {
        let Some(root) = self.root.as_deref() else {
            return;
        };
        if bytes.is_empty() {
            return;
        }
        let mut writers = self.writers.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(writer) = writers.get(session_id) {
            if writer.offer(bytes) {
                return;
            }
            // The writer died (its file went bad); a fresh one takes over from here.
            if let Some(dead) = writers.remove(session_id) {
                dead.close();
            }
        }
        let path = entry_path(root, session_id, OUTPUT_EXTENSION);
        let Some(writer) = LogWriter::start(session_id, path) else {
            return;
        };
        writer.offer(bytes);
        writers.insert(session_id.to_owned(), writer);
    }

    /// Wait until every chunk appended so far is on disk. The writer thread otherwise lags the
    /// live terminal by design; anything reading the file wants the lag closed first.
    pub fn flush(&self, session_id: &str) {
        let sender = self
            .writers
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(session_id)
            .map(|writer| writer.sender.clone());
        if let Some(sender) = sender {
            LogWriter::flush(&sender);
        }
    }

    /// The retained output for a session, oldest first. Empty when nothing was kept.
    pub fn output(&self, session_id: &str) -> Vec<u8> {
        let Some(root) = self.root.as_deref() else {
            return Vec::new();
        };
        self.flush(session_id);
        fs::read(entry_path(root, session_id, OUTPUT_EXTENSION)).unwrap_or_default()
    }

    /// The current definition for one Talkak session. A spawn replaces this record before its
    /// reader starts, so `run_id`, `started_at_ms`, cwd, and command identify the latest run even
    /// after the desktop app process restarts.
    pub fn definition(&self, session_id: &str) -> Option<StoredSession> {
        let root = self.root.as_deref()?;
        fs::read(entry_path(root, session_id, DEFINITION_EXTENSION))
            .ok()
            .and_then(|raw| serde_json::from_slice(&raw).ok())
    }

    /// Every stored session record, newest first.
    pub fn restorable(&self) -> Vec<RestorableSession> {
        let Some(root) = self.root.as_deref() else {
            return Vec::new();
        };
        let Ok(entries) = fs::read_dir(root) else {
            return Vec::new();
        };
        let mut sizes: HashMap<String, u64> = HashMap::new();
        let mut definitions: Vec<StoredSession> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            match path.extension().and_then(|value| value.to_str()) {
                Some(DEFINITION_EXTENSION) => {
                    if let Some(session) = fs::read(&path)
                        .ok()
                        .and_then(|raw| serde_json::from_slice::<StoredSession>(&raw).ok())
                    {
                        definitions.push(session);
                    }
                }
                Some(OUTPUT_EXTENSION) => {
                    if let Some(stem) = path.file_stem().and_then(|value| value.to_str()) {
                        let bytes = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
                        sizes.insert(stem.to_owned(), bytes);
                    }
                }
                _ => {}
            }
        }
        let mut restorable = definitions
            .into_iter()
            .map(|session| {
                let output_bytes = sizes
                    .get(&encode_name(&session.session_id))
                    .copied()
                    .unwrap_or(0);
                RestorableSession {
                    session,
                    output_bytes,
                }
            })
            .collect::<Vec<_>>();
        restorable.sort_by(|left, right| {
            right
                .session
                .started_at_ms
                .cmp(&left.session.started_at_ms)
                .then_with(|| left.session.session_id.cmp(&right.session.session_id))
        });
        restorable
    }

    /// Drop a session's record and output. Used when a session is discarded for good.
    pub fn forget(&self, session_id: &str) {
        let Some(root) = self.root.as_deref() else {
            return;
        };
        // Windows refuses to delete a file something still has open.
        self.close_log(session_id);
        let _ = fs::remove_file(entry_path(root, session_id, DEFINITION_EXTENSION));
        let _ = fs::remove_file(entry_path(root, session_id, OUTPUT_EXTENSION));
    }
}

impl Drop for SessionStore {
    /// Let every writer drain before the store goes: the broker shutting down, or a test reading
    /// the files back through a new store over the same root.
    fn drop(&mut self) {
        let writers = self
            .writers
            .get_mut()
            .unwrap_or_else(PoisonError::into_inner);
        for (_, writer) in writers.drain() {
            writer.close();
        }
    }
}

/// Hex so every byte of an id maps to `[0-9a-f]`. That is a legal file name on both platforms and
/// cannot produce a separator, a `..`, or a Windows reserved device name.
fn encode_name(session_id: &str) -> String {
    let mut encoded = String::with_capacity(session_id.len() * 2);
    for byte in session_id.as_bytes() {
        encoded.push(char::from_digit((byte >> 4) as u32, 16).unwrap_or('0'));
        encoded.push(char::from_digit((byte & 0x0f) as u32, 16).unwrap_or('0'));
    }
    encoded
}

fn entry_path(root: &Path, session_id: &str, extension: &str) -> PathBuf {
    root.join(format!("{}.{extension}", encode_name(session_id)))
}

/// Write through a temporary file so a crash mid-write cannot leave a half-parsed record.
fn write_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, bytes)?;
    // Windows rename fails onto an existing file; removing first keeps both platforms on one path.
    let _ = fs::remove_file(path);
    fs::rename(&temporary, path)
}

/// Keep the newest `LOG_RETAINED_BYTES` of the file. Reads only that tail — the writer thread is
/// the one doing this, and pulling the whole eight megabytes through memory was most of the cost.
fn rotate(path: &Path) {
    let Ok(mut existing) = fs::File::open(path) else {
        return;
    };
    let Ok(length) = existing.metadata().map(|meta| meta.len()) else {
        return;
    };
    let start = length.saturating_sub(LOG_RETAINED_BYTES);
    if existing.seek(SeekFrom::Start(start)).is_err() {
        return;
    }
    let mut tail = Vec::with_capacity((length - start) as usize);
    if existing.read_to_end(&mut tail).is_err() {
        return;
    }
    drop(existing);
    let _ = write_atomically(path, &tail);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("talkak-store-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        root
    }

    fn sample(session_id: &str, started_at_ms: u64) -> StoredSession {
        StoredSession {
            session_id: session_id.to_owned(),
            run_id: Some(1),
            cwd: Some("/projects/app".into()),
            command: None,
            args: vec![],
            cols: 80,
            rows: 24,
            started_at_ms,
        }
    }

    #[test]
    fn a_disabled_store_keeps_nothing_and_never_errors() {
        let store = SessionStore::default();
        assert!(!store.enabled());
        store
            .record(&sample("pane-1", 1_755_255_600_000))
            .expect("record is a no-op");
        store.append_output("pane-1", b"hello");
        assert!(store.output("pane-1").is_empty());
        assert!(store.restorable().is_empty());
    }

    #[test]
    fn a_definition_from_an_older_install_without_run_id_still_loads() {
        let legacy = r#"{"sessionId":"pane-1","cwd":"/projects/app","command":"codex","args":[],"cols":80,"rows":24,"startedAtMs":1755255600000}"#;
        let session: StoredSession = serde_json::from_str(legacy).expect("legacy definition");
        assert_eq!(session.run_id, None);
    }

    #[test]
    fn a_recorded_session_survives_a_new_store_over_the_same_root() {
        let root = store_root("survives");
        let first = SessionStore::at(&root);
        assert!(first.enabled());
        first
            .record(&sample("pane-1", 1_755_255_600_000))
            .expect("record should write");
        first.append_output("pane-1", b"build finished\n");
        // Dropping the store waits for its writer, so nothing is still in flight here.
        drop(first);

        // A new store instance over the same root can read the internal evidence.
        let reopened = SessionStore::at(&root);
        assert_eq!(reopened.output("pane-1"), b"build finished\n");
        let restorable = reopened.restorable();
        assert_eq!(restorable.len(), 1);
        assert_eq!(restorable[0].session.session_id, "pane-1");
        assert_eq!(restorable[0].session.cwd.as_deref(), Some("/projects/app"));
        assert_eq!(restorable[0].output_bytes, "build finished\n".len() as u64);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn recording_a_session_again_drops_the_previous_runs_output() {
        let root = store_root("rerecord");
        let store = SessionStore::at(&root);
        store
            .record(&sample("pane-1", 1_755_255_600_000))
            .expect("first record");
        store.append_output("pane-1", b"first run\n");
        store
            .record(&sample("pane-1", 1_755_259_200_000))
            .expect("second record");
        assert!(store.output("pane-1").is_empty());
        assert_eq!(store.restorable().len(), 1);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn ids_that_look_like_paths_or_windows_devices_stay_inside_the_store() {
        let root = store_root("escape");
        let store = SessionStore::at(&root);
        for hostile in ["../../etc/passwd", "a/b\\c", "NUL", "COM1", "pane:1"] {
            store
                .record(&sample(hostile, 1_755_255_600_000))
                .expect("record");
            store.append_output(hostile, b"x");
            assert_eq!(store.output(hostile), b"x");
        }
        for entry in fs::read_dir(&root)
            .expect("store root should be readable")
            .flatten()
        {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let stem = name.split('.').next().unwrap_or_default();
            assert!(
                stem.chars().all(|value| value.is_ascii_hexdigit()),
                "file name {name} is not hex-encoded"
            );
        }
        assert_eq!(store.restorable().len(), 5);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn restorable_sessions_come_back_newest_first() {
        let root = store_root("ordering");
        let store = SessionStore::at(&root);
        store
            .record(&sample("older", 1_755_252_000_000))
            .expect("record");
        store
            .record(&sample("newer", 1_755_262_800_000))
            .expect("record");
        let ids = store
            .restorable()
            .into_iter()
            .map(|entry| entry.session.session_id)
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["newer".to_string(), "older".to_string()]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_forgotten_session_leaves_no_record_or_output() {
        let root = store_root("forget");
        let store = SessionStore::at(&root);
        store
            .record(&sample("pane-1", 1_755_255_600_000))
            .expect("record");
        store.append_output("pane-1", b"output");
        store.forget("pane-1");
        assert!(store.output("pane-1").is_empty());
        assert!(store.restorable().is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_long_running_session_log_stays_bounded_and_keeps_the_newest_output() {
        let root = store_root("rotate");
        let store = SessionStore::at(&root);
        store
            .record(&sample("pane-1", 1_755_255_600_000))
            .expect("record");
        let chunk = vec![b'a'; 512 * 1024];
        for _ in 0..10 {
            store.append_output("pane-1", &chunk);
        }
        store.append_output("pane-1", b"NEWEST");
        let output = store.output("pane-1");
        assert!(
            output.len() as u64 <= MAX_LOG_BYTES,
            "log grew to {} bytes",
            output.len()
        );
        assert!(output.ends_with(b"NEWEST"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn appends_keep_their_order_and_a_flush_closes_the_lag() {
        // The writer thread lags the reader by design; `output` must still see every byte that
        // was appended before it was asked, in the order it was appended.
        let root = store_root("ordered");
        let store = SessionStore::at(&root);
        store
            .record(&sample("pane-1", 1_755_255_600_000))
            .expect("record");
        let mut expected = Vec::new();
        for index in 0..200_u32 {
            let line = format!("line {index}\n");
            store.append_output("pane-1", line.as_bytes());
            expected.extend_from_slice(line.as_bytes());
        }
        assert_eq!(store.output("pane-1"), expected);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_writer_whose_file_vanished_is_replaced_by_the_next_append() {
        // Windows will not let the file go while the writer holds it, so this exercise is unix
        // shaped; the recovery path it proves — a dead writer being replaced — is the same code
        // on both platforms.
        let root = store_root("replace");
        let store = SessionStore::at(&root);
        store
            .record(&sample("pane-1", 1_755_255_600_000))
            .expect("record");
        store.append_output("pane-1", b"before ");
        store.flush("pane-1");
        store.close_log("pane-1");
        store.append_output("pane-1", b"after");
        assert_eq!(store.output("pane-1"), b"before after");
        let _ = fs::remove_dir_all(&root);
    }
}
