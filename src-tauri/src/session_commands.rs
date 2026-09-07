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

/// A pane asking after its saved session. Live → its snapshot. Not live but kept by the broker's
/// store for a run that was still alive when the store was last written (the broker died, was
/// replaced, or the machine restarted) → brought back here under the same id, with the vault's
/// environment, its old output kept and a divider before the new run. A run that ended — `exit`,
/// Stop, a crash of the child — stays ended: the pane shows its launcher as before.
#[tauri::command(async)]
pub(crate) fn session_snapshot(
    runtime: State<'_, SessionRuntime>,
    vault: State<'_, EnvVault>,
    request: SessionIdRequest,
) -> Result<Option<SessionSnapshot>, String> {
    let session_id = request.session_id.clone();
    if let Some(snapshot) = runtime
        .snapshot(request)
        .map_err(|error| error.to_string())?
    {
        return Ok(Some(snapshot));
    }
    if !runtime.has_capability("restore") {
        return Ok(None);
    }
    let Some(stored) = runtime
        .restorable()
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|entry| entry.session)
        .find(|stored| stored.session_id == session_id)
    else {
        return Ok(None);
    };
    if stored.ended_at_ms.is_some() {
        return Ok(None);
    }
    let env = vault.session_env(stored.cwd.as_deref());
    runtime
        .spawn(SpawnSessionRequest {
            session_id,
            cwd: stored.cwd,
            command: stored.command,
            args: stored.args,
            env,
            cols: stored.cols,
            rows: stored.rows,
            restore: true,
        })
        .map(Some)
        .map_err(|error| error.to_string())
}

/// The output the broker kept on disk for a session — what a restored run showed before the
/// divider. Base64 so a multi-megabyte log crosses IPC as one string.
#[tauri::command(async)]
pub(crate) fn session_stored_output(
    runtime: State<'_, SessionRuntime>,
    request: SessionIdRequest,
) -> Result<String, String> {
    runtime
        .stored_output(&request.session_id)
        .map(|bytes| session_broker::base64::encode(&bytes))
        .map_err(|error| error.to_string())
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResumeAgentRequest {
    pub session_id: String,
    pub run_id: u64,
    /// Agent name → recipe with `{id}`; the renderer's settings. Missing names use the defaults.
    #[serde(default)]
    pub recipes: Vec<(String, String)>,
}

/// Type the agent's own resume command into a restored run, once. Returns the line typed, or
/// null when there was nothing to resume: no binding, a recipe switched off, or this run already
/// resumed. Never types into a run that was not restored.
#[tauri::command(async)]
pub(crate) fn session_resume_agent(
    runtime: State<'_, SessionRuntime>,
    request: ResumeAgentRequest,
) -> Result<Option<String>, String> {
    let snapshot = runtime
        .snapshot(SessionIdRequest {
            session_id: request.session_id.clone(),
        })
        .map_err(|error| error.to_string())?;
    let Some(snapshot) = snapshot else {
        return Ok(None);
    };
    if !snapshot.restored || !snapshot.running || snapshot.run_id != request.run_id {
        return Ok(None);
    }
    let sessions_dir = runtime.sessions_dir();
    let Some(binding) = crate::agent_binding::load(sessions_dir, &request.session_id) else {
        return Ok(None);
    };
    if binding.resumed_run_id == Some(request.run_id) {
        return Ok(None);
    }
    let Some(line) = crate::agent_binding::resume_command(&binding, &request.recipes) else {
        return Ok(None);
    };
    let mut data = line.clone().into_bytes();
    data.push(b'\r');
    runtime
        .write(WriteSessionRequest {
            session_id: request.session_id.clone(),
            run_id: request.run_id,
            data,
        })
        .map_err(|error| error.to_string())?;
    crate::agent_binding::mark_resumed(sessions_dir, &request.session_id, request.run_id);
    Ok(Some(line))
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
    let session_id = request.session_id.clone();
    runtime
        .discard(request)
        .map_err(|error| error.to_string())?;
    crate::agent_binding::forget(runtime.sessions_dir(), &session_id);
    Ok(())
}

/// Every session the broker is holding, alive or finished. Sessions outlive the panes that opened
/// them by design, so without this list a shell could run for days with nothing able to find it.
#[tauri::command(async)]
pub(crate) fn session_live(runtime: State<'_, SessionRuntime>) -> Result<Vec<LiveSession>, String> {
    runtime.live_sessions().map_err(|error| error.to_string())
}
