//! The broker's lifecycle log, readable from inside the app.
//!
//! The broker runs detached with its stdio nulled, so its only voice is
//! `<app-data>/broker/broker.log` (see `session_broker::logging`). Until now, diagnosing a broker
//! problem meant finding that file by hand. This is a bounded tail of it — newest first, optionally
//! only the lines that look like trouble — for a small viewer under Settings. It is the broker's
//! log and nothing else: the app writes no runtime log of its own, and the viewer says so.

use serde::Serialize;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use tauri::Manager;

/// How much of the file's end is read. The log is lifecycle events only, so this is weeks of
/// activity; anything older is beyond what a tail is for.
const TAIL_BYTES: u64 = 512 * 1024;
const MAX_LINES: usize = 2000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrokerLogLine {
    /// "problem" for a line that reads like a failure, "info" for everything else. The broker's
    /// log carries no level field; this is a heuristic and the UI labels it as one.
    pub(crate) level: &'static str,
    pub(crate) text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrokerLogTail {
    /// Where the log lives on this machine, so the viewer can say what it is showing.
    pub(crate) path: Option<String>,
    /// Whether that file exists. No file is not an error: a broker that has never run has none.
    pub(crate) present: bool,
    /// Newest first, at most `limit` lines.
    pub(crate) lines: Vec<BrokerLogLine>,
    /// Whether the file is longer than what was read, so the viewer can say the tail is partial.
    pub(crate) partial: bool,
}

/// A bounded, newest-first tail of the broker log. Both platforms resolve the file from the app
/// data directory the broker was told about at launch (`session_runtime::SessionRuntime::attach`
/// hands it `<app-data>`; the broker writes `<app-data>/broker/broker.log`).
#[tauri::command(async)]
pub(crate) fn broker_log_tail(
    app: tauri::AppHandle,
    only_problems: bool,
    limit: usize,
) -> Result<BrokerLogTail, String> {
    let path = app
        .path()
        .app_data_dir()
        .ok()
        .map(|directory| broker_log_path(&directory));
    let Some(path) = path else {
        return Ok(BrokerLogTail {
            path: None,
            present: false,
            lines: Vec::new(),
            partial: false,
        });
    };
    let display = path.to_string_lossy().into_owned();
    if !path.is_file() {
        return Ok(BrokerLogTail {
            path: Some(display),
            present: false,
            lines: Vec::new(),
            partial: false,
        });
    }
    let tail = read_tail(&path, TAIL_BYTES).map_err(|error| format!("read {display}: {error}"))?;
    Ok(BrokerLogTail {
        path: Some(display),
        present: true,
        lines: tail_lines(&tail.text, only_problems, limit),
        partial: tail.partial,
    })
}

pub(crate) fn broker_log_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("broker").join("broker.log")
}

struct Tail {
    text: String,
    partial: bool,
}

/// The last `max_bytes` of a file as text. When the read starts mid-file, the first (possibly cut)
/// line is dropped so every returned line is whole.
fn read_tail(path: &Path, max_bytes: u64) -> std::io::Result<Tail> {
    let mut file = std::fs::File::open(path)?;
    let length = file.metadata()?.len();
    let start = length.saturating_sub(max_bytes);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::with_capacity((length - start) as usize);
    file.read_to_end(&mut bytes)?;
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    let partial = start > 0;
    if partial {
        match text.find('\n') {
            Some(cut) => text.drain(..=cut),
            None => text.drain(..),
        };
    }
    Ok(Tail { text, partial })
}

/// Newest first, problems only when asked, never more than `limit` (clamped to a sane range).
pub(crate) fn tail_lines(text: &str, only_problems: bool, limit: usize) -> Vec<BrokerLogLine> {
    let limit = limit.clamp(1, MAX_LINES);
    text.lines()
        .rev()
        .filter(|line| !line.trim().is_empty())
        .map(|line| BrokerLogLine {
            level: if is_problem(line) { "problem" } else { "info" },
            text: line.to_owned(),
        })
        .filter(|line| !only_problems || line.level == "problem")
        .take(limit)
        .collect()
}

/// The broker log has no level tags, so a problem is recognised by what the broker says when
/// something goes wrong: a panic, a failure, a recovered lock, an unexpected exit. Anything the
/// broker logs on its happy path ("starting", "attach", "spawn requested", "exiting: idle") is not.
pub(crate) fn is_problem(line: &str) -> bool {
    let lower = line.to_lowercase();
    if lower.contains("panic") {
        return true;
    }
    for marker in [
        "error",
        "failed",
        "failure",
        "refused",
        "poisoned",
        "ignored an unmatched",
        "incompatible",
        "cannot ",
        "could not",
    ] {
        if lower.contains(marker) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn happy_path_lines_are_not_problems_and_failures_are() {
        for calm in [
            "[10:00:00.000Z pid=1] starting 0.1.0 endpoint=/tmp/broker.sock store=Some(\"/s\")",
            "[10:00:01.000Z pid=1] spawn requested: session-1",
            "[10:00:02.000Z pid=1] attach: session-1 after 0",
            "[10:00:03.000Z pid=1] kill requested: session-1 run 3",
            "[10:00:04.000Z pid=1] last client left: shutdown_requested=false sessions_running=true",
            "[10:00:05.000Z pid=1] exiting: idle",
        ] {
            assert!(!is_problem(calm), "{calm}");
        }
        for trouble in [
            "[10:00:00.000Z pid=1] PANIC: panicked at src/server.rs:10:5",
            "[10:00:00.000Z pid=1] exiting: server error: address in use",
            "[10:00:00.000Z pid=1] recovering poisoned output buffer lock",
            "[10:00:00.000Z pid=1] ignored an unmatched client-close event",
            "[10:00:00.000Z pid=1] failed to start PTY reader: too many threads",
        ] {
            assert!(is_problem(trouble), "{trouble}");
        }
    }

    #[test]
    fn the_tail_is_newest_first_filtered_and_bounded() {
        let text = "a starting\nb spawn requested: s\nc PANIC: boom\n\nd exiting: idle\n";
        let everything = tail_lines(text, false, 10);
        assert_eq!(
            everything
                .iter()
                .map(|line| line.text.as_str())
                .collect::<Vec<_>>(),
            vec![
                "d exiting: idle",
                "c PANIC: boom",
                "b spawn requested: s",
                "a starting"
            ]
        );
        assert_eq!(everything[1].level, "problem");
        assert_eq!(everything[0].level, "info");

        let problems = tail_lines(text, true, 10);
        assert_eq!(problems.len(), 1);
        assert_eq!(problems[0].text, "c PANIC: boom");

        let bounded = tail_lines(text, false, 2);
        assert_eq!(bounded.len(), 2);
        assert_eq!(bounded[0].text, "d exiting: idle");

        // A zero limit still yields something rather than an empty answer that reads as "no log".
        assert_eq!(tail_lines(text, false, 0).len(), 1);
    }

    #[test]
    fn a_tail_read_mid_file_drops_the_cut_first_line() {
        let directory = tempfile::tempdir().expect("temp dir");
        let path = directory.path().join("broker.log");
        std::fs::write(&path, "first line\nsecond line\nthird line\n").expect("write");

        let whole = read_tail(&path, 1024).expect("read");
        assert!(!whole.partial);
        assert_eq!(whole.text, "first line\nsecond line\nthird line\n");

        // 16 bytes from the end lands inside "second line".
        let cut = read_tail(&path, 16).expect("read");
        assert!(cut.partial);
        assert_eq!(cut.text, "third line\n");
    }

    #[test]
    fn the_log_path_sits_beside_the_brokers_own_copy_under_app_data() {
        let path = broker_log_path(Path::new("/data/dev.talkak.desktop"));
        assert!(path.ends_with(Path::new("broker").join("broker.log")));
        assert!(path.starts_with("/data/dev.talkak.desktop"));
    }
}
