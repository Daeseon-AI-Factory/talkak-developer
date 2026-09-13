use crate::env_vault::EnvVault;
use crate::session_runtime::{
    LiveSession, ReadSessionRequest, ResizeSessionRequest, RunSessionRequest, SessionIdRequest,
    SessionRead, SessionRuntime, SessionSnapshot, SpawnSessionRequest, WriteSessionRequest,
};
use std::sync::Mutex;
use std::time::{Duration, Instant};
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
    // The reservation is taken under a lock and before the line is typed: two panes asking at
    // once must not both type it, and the wait for the shell below widens that window.
    let line = {
        let _reservation = RESUME_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let Some(binding) = crate::agent_binding::load(sessions_dir, &request.session_id) else {
            return Ok(None);
        };
        if binding.resumed_run_id == Some(request.run_id) {
            return Ok(None);
        }
        let Some(line) = crate::agent_binding::resume_command(&binding, &request.recipes) else {
            return Ok(None);
        };
        crate::agent_binding::mark_resumed(sessions_dir, &request.session_id, request.run_id);
        line
    };

    wait_until_ready(&runtime, &request.session_id, request.run_id, snapshot.next);

    let mut data = line.clone().into_bytes();
    data.push(b'\r');
    match runtime.write(WriteSessionRequest {
        session_id: request.session_id.clone(),
        run_id: request.run_id,
        data,
    }) {
        Ok(()) => Ok(Some(line)),
        Err(error) => {
            crate::agent_binding::set_resumed(sessions_dir, &request.session_id, None);
            Err(error.to_string())
        }
    }
}

/// Serializes the reservation above. Resumes are rare and the section holds no I/O wait.
static RESUME_LOCK: Mutex<()> = Mutex::new(());

/// How often the wait below asks the broker where the run's output stands, and how long it waits
/// before typing anyway. A shell that never prints a prompt must not hold the resume forever.
const READY_POLL: Duration = Duration::from_millis(120);
const READY_LIMIT: Duration = Duration::from_secs(5);

/// Whether a restored run is ready for the line: it has printed something of its own — the
/// restore's divider is already in `start_next`, so anything past it is the shell — and has then
/// stayed quiet long enough for the prompt to be drawn. Typed earlier, the line lands before the
/// prompt: the terminal echoes it, and a shell that resets the terminal as it starts can drop it.
///
/// A run that prints nothing of its own is not held forever. Once it has been silent from the
/// start for `READY_SILENT_FLOOR`, which is longer than any shell takes to reach its banner, the
/// line goes in anyway — a session whose command has no prompt still gets its resume.
#[derive(Debug)]
pub(crate) struct ResumeReadiness {
    start_next: u64,
    last_next: u64,
    started: Instant,
    quiet_since: Option<Instant>,
}

/// How long a restored run must stay quiet before its prompt is taken as drawn.
const READY_QUIET: Duration = Duration::from_millis(300);
/// How long a run that has printed nothing at all is given before the line goes in regardless.
const READY_SILENT_FLOOR: Duration = Duration::from_millis(1_500);

impl ResumeReadiness {
    pub(crate) fn new(start_next: u64, now: Instant) -> Self {
        Self {
            start_next,
            last_next: start_next,
            started: now,
            quiet_since: None,
        }
    }

    /// Feed the run's output cursor; true once the run looks ready to read a line.
    pub(crate) fn observe(&mut self, next: u64, now: Instant) -> bool {
        if next != self.last_next {
            self.last_next = next;
            self.quiet_since = None;
            return false;
        }
        let quiet_since = *self.quiet_since.get_or_insert(now);
        if now.duration_since(quiet_since) < READY_QUIET {
            return false;
        }
        next > self.start_next || now.duration_since(self.started) >= READY_SILENT_FLOOR
    }
}

fn wait_until_ready(runtime: &SessionRuntime, session_id: &str, run_id: u64, start_next: u64) {
    let mut readiness = ResumeReadiness::new(start_next, Instant::now());
    let deadline = Instant::now() + READY_LIMIT;
    while Instant::now() < deadline {
        std::thread::sleep(READY_POLL);
        let Ok(Some(snapshot)) = runtime.snapshot(SessionIdRequest {
            session_id: session_id.to_owned(),
        }) else {
            return;
        };
        if !snapshot.running || snapshot.run_id != run_id {
            return;
        }
        if readiness.observe(snapshot.next, Instant::now()) {
            return;
        }
    }
}

/// Where the broker keeps this app's session definitions, output logs and agent bindings. The
/// recovery settings show it, so the store is findable rather than described.
#[tauri::command(async)]
pub(crate) fn session_store_dir(runtime: State<'_, SessionRuntime>) -> Option<String> {
    runtime
        .sessions_dir()
        .map(|dir| dir.to_string_lossy().into_owned())
}

#[cfg(test)]
mod readiness_tests {
    use super::{ResumeReadiness, READY_QUIET, READY_SILENT_FLOOR};
    use std::time::{Duration, Instant};

    #[test]
    fn a_run_is_ready_once_its_own_output_has_stopped_arriving() {
        let start = Instant::now();
        let mut readiness = ResumeReadiness::new(100, start);
        // The shell prints its banner, then its prompt.
        assert!(!readiness.observe(140, start + Duration::from_millis(100)));
        assert!(!readiness.observe(180, start + Duration::from_millis(200)));
        // Quiet, but not yet long enough.
        assert!(!readiness.observe(180, start + Duration::from_millis(200)));
        assert!(!readiness.observe(180, start + Duration::from_millis(200) + READY_QUIET / 2));
        assert!(readiness.observe(180, start + Duration::from_millis(200) + READY_QUIET));
    }

    #[test]
    fn late_output_restarts_the_quiet_window() {
        let start = Instant::now();
        let mut readiness = ResumeReadiness::new(0, start);
        assert!(!readiness.observe(10, start));
        assert!(!readiness.observe(10, start + Duration::from_millis(10)));
        assert!(!readiness.observe(20, start + Duration::from_millis(20)));
        assert!(!readiness.observe(20, start + Duration::from_millis(30)));
        assert!(readiness.observe(20, start + Duration::from_millis(30) + READY_QUIET));
    }

    #[test]
    fn a_run_that_prints_nothing_of_its_own_is_not_held_past_the_floor() {
        let start = Instant::now();
        let mut readiness = ResumeReadiness::new(100, start);
        // A shell that is still starting must not be mistaken for one that will never print.
        assert!(!readiness.observe(100, start));
        assert!(!readiness.observe(100, start + READY_QUIET));
        assert!(!readiness.observe(100, start + READY_SILENT_FLOOR - READY_QUIET));
        assert!(readiness.observe(100, start + READY_SILENT_FLOOR));
    }
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
