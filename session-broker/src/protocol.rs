//! Wire protocol — line-delimited JSON over the transport (unix socket on macOS, named pipe on
//! Windows). Ids are app-supplied stable pane/session ids so they survive reattach.

use serde::{Deserialize, Serialize};

/// Client → broker. `method` tags the variant. Serialize (client sends) + Deserialize (broker reads).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "snake_case")]
pub enum Request {
    /// Handshake; the broker replies with its version + pid.
    Hello { proto_version: u32 },
    /// Create a session (no-op if `session_id` is already live → idempotent reattach).
    Spawn {
        session_id: String,
        program: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        cwd: Option<String>,
        #[serde(default)]
        env: Vec<(String, String)>,
        #[serde(default)]
        cols: u16,
        #[serde(default)]
        rows: u16,
    },
    /// Subscribe this connection to a session's output. Buffered scrollback is replayed first.
    Attach { session_id: String },
    /// Write bytes (as a UTF-8 string) to the session's PTY.
    Write { session_id: String, data: String },
    /// Resize the session's PTY.
    Resize {
        session_id: String,
        cols: u16,
        rows: u16,
    },
    /// List live sessions (the introspection surface that replaces tmux `list-sessions`/`pane_pid`).
    List,
    /// Return the last `lines` of a session's scrollback (replaces tmux `capture-pane`). `0` = all.
    Capture { session_id: String, lines: usize },
    /// Terminate a session and drop it from the registry.
    Kill { session_id: String },
}

/// Broker → client. `type` tags the variant. Serialize (broker sends) + Deserialize (client reads).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Response {
    Hello {
        broker_version: String,
        pid: u32,
    },
    Spawned {
        session_id: String,
        child_pid: Option<u32>,
    },
    Ok,
    /// A chunk of session output (streamed after `attach`).
    Output {
        session_id: String,
        data: String,
    },
    /// The session's PTY reached EOF / was killed.
    Closed {
        session_id: String,
    },
    List {
        sessions: Vec<SessionInfo>,
    },
    /// Scrollback tail for a `Capture` request.
    Captured {
        session_id: String,
        text: String,
    },
    Error {
        message: String,
    },
}

/// One row of `List` — the introspection data consumers need (pid, running command, liveness).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub session_id: String,
    pub child_pid: Option<u32>,
    pub alive: bool,
}
