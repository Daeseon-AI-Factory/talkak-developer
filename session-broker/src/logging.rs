//! Append-only lifecycle log. The broker runs detached with stdio nulled, so without this file a
//! broker that dies takes its cause of death with it — which is exactly what happened once on a
//! real machine. Lifecycle events only (startup, connections, spawns, exits, panics); never
//! per-read/write chatter.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

static LOG: OnceLock<Option<Mutex<std::fs::File>>> = OnceLock::new();

/// Opens the log and routes panics into it. Called once from main; a broker without a store
/// directory (bare test runs) simply logs nowhere.
pub fn init(path: Option<PathBuf>) {
    let file = path.and_then(|path| {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        OpenOptions::new().create(true).append(true).open(path).ok()
    });
    let _ = LOG.set(file.map(Mutex::new));

    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log(&format!("PANIC: {info}"));
        previous(info);
    }));
}

pub fn log(message: &str) {
    let Some(Some(file)) = LOG.get().map(Option::as_ref) else {
        return;
    };
    let Ok(mut file) = file.lock() else { return };
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| {
            let secs = elapsed.as_secs();
            format!(
                "{:02}:{:02}:{:02}.{:03}Z",
                (secs / 3600) % 24,
                (secs / 60) % 60,
                secs % 60,
                elapsed.subsec_millis()
            )
        })
        .unwrap_or_default();
    let _ = writeln!(file, "[{stamp} pid={}] {message}", std::process::id());
}
