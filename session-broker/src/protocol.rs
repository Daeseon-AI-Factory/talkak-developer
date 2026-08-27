//! Wire protocol: newline-delimited JSON, strict request→response lockstep on one connection.
//!
//! The messages ARE the engine's own request/response structs, so the contract the renderer
//! already depends on (run_id validation, read start/next/truncated replay, exit codes) crosses
//! the process boundary without translation — the app client forwards, the broker executes.

use crate::runtime::{
    ReadSessionRequest, ResizeSessionRequest, RunSessionRequest, SessionIdRequest, SessionRead,
    SessionSnapshot, SpawnSessionRequest, WriteSessionRequest,
};
use crate::store::RestorableSession;
use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;

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
    Write(WriteSessionRequest),
    Resize(ResizeSessionRequest),
    Kill(RunSessionRequest),
    Discard(SessionIdRequest),
    Restorable,
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
    Restorable(Vec<RestorableSession>),
    Bytes(Vec<u8>),
    Persists(bool),
    Unit,
    ShuttingDown,
    Error {
        message: String,
    },
}
