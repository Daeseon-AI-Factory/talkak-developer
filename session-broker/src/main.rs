//! Broker binary entrypoint. Runs the transport server against a fresh `Broker`.
//!
//! Usage: `talkak-dev-broker [endpoint]` — a unix socket path (macOS/Unix) or a named-pipe name
//! (Windows). The app launches this DETACHED (`detach::spawn_detached`) so sessions survive the app.

use std::sync::Arc;

fn main() {
    let endpoint = std::env::args().nth(1).unwrap_or_else(default_endpoint);

    // Unix needs the socket's parent dir; a Windows pipe name has no filesystem parent.
    #[cfg(unix)]
    if let Some(parent) = std::path::Path::new(&endpoint).parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let runtime = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("session-broker: failed to start runtime: {e}");
            std::process::exit(1);
        }
    };
    let broker = Arc::new(session_broker::Broker::new());
    eprintln!(
        "session-broker {} listening on {endpoint}",
        env!("CARGO_PKG_VERSION")
    );

    let result = {
        #[cfg(unix)]
        {
            runtime.block_on(session_broker::server::serve_unix(&endpoint, broker))
        }
        #[cfg(windows)]
        {
            runtime.block_on(session_broker::server::serve_pipe(&endpoint, broker))
        }
    };
    if let Err(e) = result {
        eprintln!("session-broker: server error: {e}");
        std::process::exit(1);
    }
}

/// Default endpoint when the app doesn't pass one. Distinct from the original Talkak's broker
/// (`DalkkakAI/…`, `\\.\pipe\talkak-session-broker`) so both products can run on one machine, and
/// suffixed per user on Windows because the pipe namespace is machine-global.
fn default_endpoint() -> String {
    #[cfg(unix)]
    {
        let base = data_dir().unwrap_or_else(|| ".".to_string());
        format!("{base}/TalkakDev/broker/broker.sock")
    }
    #[cfg(windows)]
    {
        let user = std::env::var("USERNAME").unwrap_or_else(|_| "default".to_string());
        format!(r"\\.\pipe\talkak-dev-broker-{user}")
    }
}

/// Minimal `dirs::data_dir()` without the crate: `$HOME/Library/Application Support` (macOS),
/// `$XDG_DATA_HOME`/`$HOME/.local/share` (Linux). Unix-only; Windows uses a pipe name, no dir.
#[cfg(unix)]
fn data_dir() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        std::env::var("HOME")
            .ok()
            .map(|h| format!("{h}/Library/Application Support"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        std::env::var("XDG_DATA_HOME").ok().or_else(|| {
            std::env::var("HOME")
                .ok()
                .map(|h| format!("{h}/.local/share"))
        })
    }
}
