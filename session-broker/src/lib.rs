//! Talkak Dev session broker — a persistent, process-wide terminal session server.
//!
//! The desktop app asks the broker to `spawn` PTYs; because the broker is a separate, detached
//! process, those sessions — and the agent CLIs running in them — survive the app closing, and a
//! relaunched app reattaches. The tmux-reattach behavior, cross-platform.
//!
//! The engine (`runtime`, `store`) is the desktop app's original in-process session layer, moved
//! here wholesale so the wire protocol IS the contract the renderer already depends on: run_id
//! validation, `read(after)` start/next/truncated replay, exit codes, on-disk session records.
//! The app keeps the same ten call signatures and forwards them over a local transport.

pub mod detach;
pub mod logging;
pub mod protocol;
pub mod runtime;
#[cfg(feature = "server")]
pub mod server;
pub mod store;

pub use detach::spawn_detached;
pub use protocol::{Request, Response, PROTOCOL_VERSION};

#[cfg(test)]
mod runtime_tests;
