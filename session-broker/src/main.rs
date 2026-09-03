//! Broker binary entrypoint.
//!
//! Usage: `talkak-dev-broker [endpoint] [store_dir]` — endpoint is a unix socket path
//! (macOS/Linux) or a named-pipe name (Windows); store_dir is where session records and output
//! logs are written (the app passes its own app-data sessions directory, so the broker continues
//! the exact store the app used in-process). The app launches this DETACHED
//! (`detach::spawn_detached`) so sessions survive the app.

use session_broker::runtime::SessionRuntime;
use session_broker::store::SessionStore;
use std::sync::Arc;

fn main() {
    let endpoint = std::env::args().nth(1).unwrap_or_else(default_endpoint);
    let store_dir = std::env::args().nth(2);

    // Unix needs the socket's parent dir; a Windows pipe name has no filesystem parent.
    #[cfg(unix)]
    if let Some(parent) = std::path::Path::new(&endpoint).parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    // The log lives beside the broker's own executable copy: <app-data>/broker/broker.log.
    session_broker::logging::init(store_dir.as_ref().and_then(|dir| {
        std::path::Path::new(dir)
            .parent()
            .map(|data| data.join("broker").join("broker.log"))
    }));
    session_broker::logging::log(&format!(
        "starting {} endpoint={endpoint} store={store_dir:?}",
        env!("CARGO_PKG_VERSION")
    ));

    let runtime = match &store_dir {
        Some(dir) => SessionRuntime::with_store(SessionStore::at(std::path::PathBuf::from(dir))),
        None => SessionRuntime::default(),
    };

    let tokio_runtime = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("session-broker: failed to start runtime: {e}");
            std::process::exit(1);
        }
    };
    let runtime = Arc::new(runtime);
    eprintln!(
        "talkak-dev-broker {} listening on {endpoint}",
        env!("CARGO_PKG_VERSION")
    );

    let result = {
        #[cfg(unix)]
        {
            tokio_runtime.block_on(session_broker::server::serve_unix(
                &endpoint, runtime, store_dir,
            ))
        }
        #[cfg(windows)]
        {
            tokio_runtime.block_on(session_broker::server::serve_pipe(
                &endpoint, runtime, store_dir,
            ))
        }
    };
    if let Err(e) = result {
        session_broker::logging::log(&format!("exiting: server error: {e}"));
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
