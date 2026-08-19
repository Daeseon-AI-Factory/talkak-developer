use crate::session_runtime::{
    ReadSessionRequest, ResizeSessionRequest, RunSessionRequest, SessionIdRequest, SessionRead,
    SessionRuntime, SessionSnapshot, SpawnSessionRequest, WriteSessionRequest,
};
use crate::session_store::RestorableSession;
use tauri::State;

/// What a machine restart can bring back. `persisted` is false when no store is writable, so the
/// workspace can say plainly that nothing is being kept instead of showing an empty list as if it
/// were good news.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RestorableSessions {
    persisted: bool,
    sessions: Vec<RestorableSession>,
}

#[tauri::command]
pub(crate) fn session_restorable(
    runtime: State<'_, SessionRuntime>,
) -> Result<RestorableSessions, String> {
    Ok(RestorableSessions {
        persisted: runtime.persists(),
        sessions: runtime.restorable(),
    })
}

/// The output kept on disk for a session, so a restarted workspace can repaint what it showed
/// before. Returns an empty list when nothing was retained.
#[tauri::command]
pub(crate) fn session_stored_output(
    runtime: State<'_, SessionRuntime>,
    request: SessionIdRequest,
) -> Result<Vec<u8>, String> {
    Ok(runtime.stored_output(&request.session_id))
}

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
