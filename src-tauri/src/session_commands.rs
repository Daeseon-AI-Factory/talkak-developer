use crate::env_vault::EnvVault;
use crate::session_runtime::{
    LiveSession, ReadSessionRequest, ResizeSessionRequest, RunSessionRequest, SessionIdRequest,
    SessionRead, SessionRuntime, SessionSnapshot, SpawnSessionRequest, WriteSessionRequest,
};
use tauri::State;

// Every command here is `async`: with a non-async body that attribute puts the call on the
// runtime's blocking pool instead of the webview's IPC thread. Each one is a round trip to the
// broker — a connect, a lockstep exchange, sometimes a wait for a pool slot — and inline on the
// IPC thread one slow answer held every other pane's keystrokes and resizes behind it.

/// The vault's values ride along on every spawn, keyed by the session's working directory: the
/// app-wide entries, the project's over them, and `TALKAK_ENV_KEYS` naming what arrived.
#[tauri::command(async)]
pub(crate) fn session_spawn(
    runtime: State<'_, SessionRuntime>,
    vault: State<'_, EnvVault>,
    mut request: SpawnSessionRequest,
) -> Result<SessionSnapshot, String> {
    request.env = vault.session_env(request.cwd.as_deref());
    runtime.spawn(request).map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub(crate) fn session_snapshot(
    runtime: State<'_, SessionRuntime>,
    request: SessionIdRequest,
) -> Result<Option<SessionSnapshot>, String> {
    runtime.snapshot(request).map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub(crate) fn session_read(
    runtime: State<'_, SessionRuntime>,
    request: ReadSessionRequest,
) -> Result<SessionRead, String> {
    runtime.read(request).map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub(crate) fn session_write(
    runtime: State<'_, SessionRuntime>,
    request: WriteSessionRequest,
) -> Result<(), String> {
    runtime.write(request).map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub(crate) fn session_resize(
    runtime: State<'_, SessionRuntime>,
    request: ResizeSessionRequest,
) -> Result<(), String> {
    runtime.resize(request).map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub(crate) fn session_kill(
    runtime: State<'_, SessionRuntime>,
    request: RunSessionRequest,
) -> Result<SessionSnapshot, String> {
    runtime.kill(request).map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub(crate) fn session_discard(
    runtime: State<'_, SessionRuntime>,
    request: SessionIdRequest,
) -> Result<(), String> {
    runtime.discard(request).map_err(|error| error.to_string())
}

/// Every session the broker is holding, alive or finished. Sessions outlive the panes that opened
/// them by design, so without this list a shell could run for days with nothing able to find it.
#[tauri::command(async)]
pub(crate) fn session_live(runtime: State<'_, SessionRuntime>) -> Result<Vec<LiveSession>, String> {
    runtime.live_sessions().map_err(|error| error.to_string())
}
