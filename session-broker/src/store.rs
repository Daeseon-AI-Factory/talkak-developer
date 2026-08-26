//! On-disk session records so a machine restart does not erase a workspace.
//!
//! A running process cannot outlive a reboot, so what is persisted is what CAN come back: the
//! session definition (cwd, command, args, size) and its output. After a restart the workspace
//! shows the previous output and can relaunch the same definition under the same session id.
//!
//! Both platforms use the same layout under one caller-supplied root. Session ids are hex-encoded
//! into file names so an id containing a path separator, a `..`, or a Windows reserved device name
//! (CON, NUL, COM1 …) can never escape or collide with the store directory.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::runtime::RuntimeError;

/// Exact internal storage limits, not product promises.
const MAX_LOG_BYTES: u64 = 4 * 1024 * 1024;
/// How much of the tail survives a rotation. Keeping half amortises the rewrite cost.
const LOG_RETAINED_BYTES: usize = 2 * 1024 * 1024;

const DEFINITION_EXTENSION: &str = "json";
const OUTPUT_EXTENSION: &str = "log";

/// What a restart can restore: enough to relaunch the same session, plus when it started.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSession {
    pub session_id: String,
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

/// A session record plus the size of its retained output, for the restore list.
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
}

impl SessionStore {
    /// Create the store directory eagerly so a permission problem surfaces at startup, not on the
    /// first spawn. A root that cannot be created disables persistence instead of failing the app.
    pub fn at(root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        match fs::create_dir_all(&root) {
            Ok(()) => Self { root: Some(root) },
            Err(_) => Self { root: None },
        }
    }

    pub fn enabled(&self) -> bool {
        self.root.is_some()
    }

    /// Record a session definition. Overwrites any previous record for the same id, because a new
    /// run of that id replaces what a restart should bring back.
    pub fn record(&self, session: &StoredSession) -> Result<(), RuntimeError> {
        let Some(root) = self.root.as_deref() else {
            return Ok(());
        };
        let encoded = serde_json::to_vec(session)
            .map_err(|error| RuntimeError::Internal(format!("encode session record: {error}")))?;
        let path = entry_path(root, &session.session_id, DEFINITION_EXTENSION);
        write_atomically(&path, &encoded)
            .map_err(|error| RuntimeError::Internal(format!("write session record: {error}")))?;
        // A fresh run must not inherit the previous run's output.
        let _ = fs::remove_file(entry_path(root, &session.session_id, OUTPUT_EXTENSION));
        Ok(())
    }

    /// Append output for a session. Errors are swallowed: losing a log line must never break the
    /// live terminal, and the reader thread has no channel to report on.
    pub fn append_output(&self, session_id: &str, bytes: &[u8]) {
        let Some(root) = self.root.as_deref() else {
            return;
        };
        if bytes.is_empty() {
            return;
        }
        let path = entry_path(root, session_id, OUTPUT_EXTENSION);
        let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) else {
            return;
        };
        if file.write_all(bytes).is_err() {
            return;
        }
        if file.metadata().map(|meta| meta.len()).unwrap_or(0) > MAX_LOG_BYTES {
            drop(file);
            rotate(&path);
        }
    }

    /// The retained output for a session, oldest first. Empty when nothing was kept.
    pub fn output(&self, session_id: &str) -> Vec<u8> {
        let Some(root) = self.root.as_deref() else {
            return Vec::new();
        };
        fs::read(entry_path(root, session_id, OUTPUT_EXTENSION)).unwrap_or_default()
    }

    /// Every session a restart could bring back, newest first.
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
        let _ = fs::remove_file(entry_path(root, session_id, DEFINITION_EXTENSION));
        let _ = fs::remove_file(entry_path(root, session_id, OUTPUT_EXTENSION));
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

fn rotate(path: &Path) {
    let Ok(existing) = fs::read(path) else {
        return;
    };
    let start = existing.len().saturating_sub(LOG_RETAINED_BYTES);
    let _ = write_atomically(path, &existing[start..]);
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
    fn a_recorded_session_survives_a_new_store_over_the_same_root() {
        let root = store_root("survives");
        let first = SessionStore::at(&root);
        assert!(first.enabled());
        first
            .record(&sample("pane-1", 1_755_255_600_000))
            .expect("record should write");
        first.append_output("pane-1", b"build finished\n");
        drop(first);

        // A new process over the same root is what a machine restart looks like.
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
}
