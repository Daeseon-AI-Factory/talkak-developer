//! A single persistent terminal session: a `portable-pty` PTY + child, an output fan-out channel,
//! and a scrollback buffer so a (re)attaching client can replay what it missed.
//!
//! `portable-pty` abstracts ConPTY (Windows) and openpty (Unix) behind one API, so this whole file
//! is platform-neutral — the reason the broker is developed and tested on macOS yet targets Windows.

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;

/// Everything needed to start a session. The app fills this from its pane/backend state.
#[derive(Debug, Clone)]
pub struct SpawnSpec {
    pub session_id: String,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
}

/// Max scrollback kept per session (bytes). Bounds memory for a long-lived detached session
/// (RULE #11): overflow drops the oldest bytes. Phase 2 refines this into a proper ring.
const SCROLLBACK_CAP: usize = 256 * 1024;

pub struct Session {
    pub session_id: String,
    pub child_pid: Option<u32>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    // Shared with the reader pump so it can answer ConPTY's cursor-position query (see spawn_reader).
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    scrollback: Arc<Mutex<String>>,
    tx: broadcast::Sender<String>,
}

impl Session {
    /// Spawn the PTY + child and start the reader pump. Returns an `Arc` so the registry and the
    /// reader thread can share ownership; the session stays alive until the child exits or `kill`.
    pub fn spawn(spec: SpawnSpec) -> Result<Arc<Session>, String> {
        let cols = if spec.cols == 0 { 80 } else { spec.cols };
        let rows = if spec.rows == 0 { 24 } else { spec.rows };

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                cols,
                rows,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;

        let mut cmd = CommandBuilder::new(&spec.program);
        cmd.args(&spec.args);
        if let Some(cwd) = spec.cwd.as_deref() {
            cmd.cwd(cwd);
        }
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }

        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        let child_pid = child.process_id();
        let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

        let (tx, _rx) = broadcast::channel::<String>(1024);
        let scrollback = Arc::new(Mutex::new(String::new()));
        let writer = Arc::new(Mutex::new(writer));

        let session = Arc::new(Session {
            session_id: spec.session_id.clone(),
            child_pid,
            master: Mutex::new(pair.master),
            writer: writer.clone(),
            child: Mutex::new(child),
            scrollback: scrollback.clone(),
            tx: tx.clone(),
        });

        spawn_reader(spec.session_id, reader, scrollback, tx, writer);
        Ok(session)
    }

    /// Write bytes to the PTY.
    pub fn write(&self, data: &[u8]) -> Result<(), String> {
        let mut w = self.writer.lock().map_err(|e| e.to_string())?;
        w.write_all(data).map_err(|e| e.to_string())?;
        w.flush().map_err(|e| e.to_string())
    }

    /// Resize the PTY.
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let cols = if cols == 0 { 80 } else { cols };
        let rows = if rows == 0 { 24 } else { rows };
        let m = self.master.lock().map_err(|e| e.to_string())?;
        m.resize(PtySize {
            cols,
            rows,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
    }

    /// Subscribe to live output. Returns the buffered scrollback snapshot AND a receiver, taken
    /// under the scrollback lock so no chunk is both in the snapshot and the stream (no dup/loss).
    pub fn attach(&self) -> (String, broadcast::Receiver<String>) {
        let sb = self.scrollback.lock().expect("scrollback poisoned");
        let rx = self.tx.subscribe();
        (sb.clone(), rx)
    }

    /// A fresh live-output receiver without the scrollback (used by tests).
    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.tx.subscribe()
    }

    /// The last `lines` lines of scrollback (`0` = all) — replaces tmux `capture-pane`.
    pub fn capture(&self, lines: usize) -> String {
        let sb = match self.scrollback.lock() {
            Ok(sb) => sb,
            Err(_) => return String::new(),
        };
        if lines == 0 {
            return sb.clone();
        }
        // Take the last `lines` newline-delimited lines.
        let start = sb
            .rmatch_indices('\n')
            .nth(lines) // the (lines)-th newline from the end bounds `lines` trailing lines
            .map(|(i, _)| i + 1)
            .unwrap_or(0);
        sb[start..].to_string()
    }

    /// Is the child still running?
    pub fn alive(&self) -> bool {
        self.child
            .lock()
            .ok()
            .map(|mut c| c.try_wait().ok().flatten().is_none())
            .unwrap_or(false)
    }

    /// Kill the child. The reader pump then sees EOF and emits `Closed`.
    pub fn kill(&self) -> Result<(), String> {
        let mut c = self.child.lock().map_err(|e| e.to_string())?;
        c.kill().map_err(|e| e.to_string())
    }
}

/// Reader pump: PTY → valid-UTF-8 chunks → (scrollback append + broadcast) under ONE lock so
/// `attach` sees a consistent split. Runs on a std thread because `portable-pty` reads are blocking.
///
/// It also answers ConPTY's cursor-position query (`ESC[6n`): Windows ConPTY emits it on startup and
/// STALLS the program's output until a Cursor-Position-Report comes back, so without this reply a
/// `cmd /C echo` produced only the query and no echo (2026-07-07 Windows CI finding). Harmless on
/// Unix (an interactive tty may send `[6n` too; replying is correct terminal behavior either way).
fn spawn_reader(
    session_id: String,
    mut reader: Box<dyn Read + Send>,
    scrollback: Arc<Mutex<String>>,
    tx: broadcast::Sender<String>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF — child exited / PTY closed
                Ok(n) => {
                    let chunk = drain_utf8(&mut pending, &buf[..n]);
                    if chunk.is_empty() {
                        continue;
                    }
                    // Answer a cursor-position query so ConPTY unblocks output (row 1, col 1).
                    if chunk.contains("\u{1b}[6n") {
                        if let Ok(mut w) = writer.lock() {
                            let _ = w.write_all(b"\x1b[1;1R");
                            let _ = w.flush();
                        }
                    }
                    if let Ok(mut sb) = scrollback.lock() {
                        sb.push_str(&chunk);
                        if sb.len() > SCROLLBACK_CAP {
                            // Drop oldest, keeping the last CAP bytes on a char boundary.
                            let cut = sb.len() - SCROLLBACK_CAP;
                            let cut = (cut..sb.len())
                                .find(|&i| sb.is_char_boundary(i))
                                .unwrap_or(sb.len());
                            *sb = sb[cut..].to_string();
                        }
                        let _ = tx.send(chunk); // send under the lock → consistent with attach()
                    }
                }
                Err(_) => break,
            }
        }
        // Signal EOF to any attached client with an out-of-band empty marker frame.
        let _ = tx.send(format!("\u{1b}[2m[session {session_id} closed]\u{1b}[0m"));
    });
}

/// Append `incoming` to `pending`, then return the longest valid-UTF-8 prefix, leaving an
/// incomplete trailing char in `pending` for next read (a 한글 char split across reads would
/// otherwise be lost to U+FFFD). Mirrors the app's pty.rs `drain_utf8` (2026-07-03 mojibake fix).
fn drain_utf8(pending: &mut Vec<u8>, incoming: &[u8]) -> String {
    pending.extend_from_slice(incoming);
    match std::str::from_utf8(pending) {
        Ok(s) => {
            let out = s.to_string();
            pending.clear();
            out
        }
        Err(e) => {
            let valid = e.valid_up_to();
            // SAFETY: bytes [..valid] are valid UTF-8 by from_utf8's contract.
            let out = unsafe { std::str::from_utf8_unchecked(&pending[..valid]) }.to_string();
            let rest = pending.split_off(valid);
            if rest.len() >= 4 {
                pending.clear(); // a >=4-byte tail cannot be one incomplete char — genuinely invalid
            } else {
                *pending = rest;
            }
            out
        }
    }
}
