use crate::session_runtime::{
    LiveSession, ReadSessionRequest, ResizeSessionRequest, RunSessionRequest, SessionIdRequest,
    SessionRead, SessionRuntime, SessionSnapshot, SpawnSessionRequest, WriteSessionRequest,
};
use tauri::State;

#[tauri::command]
pub(crate) fn session_spawn(
    runtime: State<'_, SessionRuntime>,
    request: SpawnSessionRequest,
) -> Result<SessionSnapshot, String> {
    runtime.spawn(request).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn session_snapshot(
    runtime: State<'_, SessionRuntime>,
    request: SessionIdRequest,
) -> Result<Option<SessionSnapshot>, String> {
    runtime.snapshot(request).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn session_read(
    runtime: State<'_, SessionRuntime>,
    request: ReadSessionRequest,
) -> Result<SessionRead, String> {
    runtime.read(request).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn session_write(
    runtime: State<'_, SessionRuntime>,
    request: WriteSessionRequest,
) -> Result<(), String> {
    runtime.write(request).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn session_resize(
    runtime: State<'_, SessionRuntime>,
    request: ResizeSessionRequest,
) -> Result<(), String> {
    runtime.resize(request).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn session_kill(
    runtime: State<'_, SessionRuntime>,
    request: RunSessionRequest,
) -> Result<SessionSnapshot, String> {
    runtime.kill(request).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn session_discard(
    runtime: State<'_, SessionRuntime>,
    request: SessionIdRequest,
) -> Result<(), String> {
    runtime.discard(request).map_err(|error| error.to_string())
}

/// Every session the broker is holding, alive or finished. Sessions outlive the panes that opened
/// them by design, so without this list a shell could run for days with nothing able to find it.
#[tauri::command]
pub(crate) fn session_live(runtime: State<'_, SessionRuntime>) -> Result<Vec<LiveSession>, String> {
    runtime.live_sessions().map_err(|error| error.to_string())
}
