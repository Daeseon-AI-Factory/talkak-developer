//! Wire protocol: newline-delimited JSON, strict request→response lockstep on one connection.
//!
//! The messages ARE the engine's own request/response structs, so the contract the renderer
//! already depends on (run_id validation, read start/next/truncated replay, exit codes) crosses
//! the process boundary without translation — the app client forwards, the broker executes.

use crate::runtime::{
    AttachSessionRequest, LiveSession, ReadSessionRequest, ResizeSessionRequest, RunSessionRequest,
    SessionIdRequest, SessionRead, SessionSnapshot, SpawnSessionRequest, WriteSessionRequest,
};
use crate::store::RestorableSession;
use serde::{Deserialize, Serialize};

/// Bump this whenever a request or response variant is added, removed, or reshaped.
///
/// A broker outlives the app that started it — that is the point of it — so a running broker is
/// routinely older than the client connecting to it. The client retires a broker whose version
/// does not match and starts a fresh one; leaving this at 1 while `Sessions` and `concurrent`
/// were added meant the client kept an incompatible broker and got "bad request" for a feature
/// it believed was there.
///
/// 2: added `Sessions` / `Response::Sessions`, and `concurrent` on the Hello response.
/// 3: output bytes cross as base64 strings, not JSON number arrays; added `Attach`, which turns a
///    connection into a push stream of `Output` frames so the renderer no longer polls.
pub const PROTOCOL_VERSION: u32 = 3;

// Adjacent tagging: internal tagging cannot represent variants whose payload is not a map
// (Option, Vec, bool) — serialization fails at runtime, which read as a dropped connection.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "method", content = "params", rename_all = "snake_case")]
pub enum Request {
    /// First request on a connection. The broker answers with its identity so a client can refuse
    /// a stale broker left over from a previous app version.
    Hello {
        protocol_version: u32,
    },
    Spawn(SpawnSessionRequest),
    Snapshot(SessionIdRequest),
    Read(ReadSessionRequest),
    /// Turn THIS connection into an output stream: the broker replays from `after`, then pushes an
    /// `Output` frame whenever the PTY produces more, a status-only frame at least once a second
    /// while idle (so a dead client is noticed and the status stays fresh), and a final frame with
    /// `running=false, read_closed=true` before closing. The client must not send anything else on
    /// the connection afterwards — on a Windows named pipe a concurrent read and write on one file
    /// object deadlock.
    Attach(AttachSessionRequest),
    Write(WriteSessionRequest),
    Resize(ResizeSessionRequest),
    Kill(RunSessionRequest),
    Discard(SessionIdRequest),
    Restorable,
    /// Every session the broker holds — the list nothing could see before.
    Sessions,
    StoredOutput(SessionIdRequest),
    Persists,
    /// Ask the broker to exit once this connection closes, sessions or not. The upgrade path:
    /// a client that finds a protocol mismatch shuts the old broker down and spawns its own.
    Shutdown,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", content = "body", rename_all = "snake_case")]
pub enum Response {
    Hello {
        protocol_version: u32,
        broker_version: String,
        pid: u32,
        store_dir: Option<String>,
        /// Whether this broker serves connections concurrently. A broker predating that fix
        /// answers one client at a time, so a client MUST hold a single connection with it or a
        /// second one waits forever — the default is deliberately the safe, old behaviour.
        #[serde(default)]
        concurrent: bool,
    },
    Snapshot(SessionSnapshot),
    MaybeSnapshot(Option<SessionSnapshot>),
    Read(SessionRead),
    /// One streamed frame after `Attach`. Same shape as a `Read` answer; `bytes` may be empty when
    /// the frame only carries status.
    Output(SessionRead),
    Restorable(Vec<RestorableSession>),
    Sessions(Vec<LiveSession>),
    Bytes(Vec<u8>),
    Persists(bool),
    Unit,
    ShuttingDown,
    Error {
        message: String,
    },
}
