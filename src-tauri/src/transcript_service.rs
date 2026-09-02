//! Session-scoped discovery and incremental reading for agent-owned JSONL transcripts.
//!
//! Discovery is deliberately paid once per Talkak session. After that, the exact record path is
//! bound to the session id and only bytes appended after the last complete line are parsed. A
//! session with no record remembers that too: a plain shell pane is polled every few seconds, and
//! re-listing every historical record on each poll kept the disk busy for nothing.

use crate::agent_transcript::{AgentTranscript, Binding, TranscriptSource, MAX_TRANSCRIPT_ENTRIES};
use crate::transcript_activity::AgentActivity;
use crate::transcript_bound::BoundTranscript;
use crate::transcript_discovery::{
    discover_record, parse_rfc3339_ms, provider_hint, system_time_ms, watched_paths, Candidate,
};
use crate::transcript_paths::{home_dir, normalised_path};
use crate::transcript_selection::claude_record_intent;
use serde::Serialize;
use session_broker::store::SessionStore;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

#[derive(Clone)]
pub(crate) struct TranscriptService {
    home: Option<PathBuf>,
    store: Option<Arc<SessionStore>>,
    /// The registry only finds a session cache; its own lock coalesces reads without blocking peers.
    cache: Arc<Mutex<HashMap<String, SessionCache>>>,
    #[cfg(test)]
    cold_read_hook: Option<ColdReadHook>,
}

type SessionCache = Arc<Mutex<Option<CachedSession>>>;
#[cfg(test)]
type ColdReadHook = Arc<dyn Fn(&str) + Send + Sync>;

/// How the renderer identifies one Talkak session to every transcript command.
#[derive(Debug, Clone)]
pub(crate) struct TranscriptScope {
    pub session_id: String,
    pub run_id: Option<u64>,
    pub project_path: String,
    pub started_at: Option<String>,
    pub agent_command: Option<String>,
}

/// What a transcript read hands back: the reader says which revision it already holds, and an
/// unchanged record costs one stat instead of an 800-entry clone across IPC.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum TranscriptRead {
    Unchanged { revision: u64 },
    Transcript { transcript: Box<AgentTranscript> },
    Absent,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentActivityRead {
    pub activity: AgentActivity,
    pub revision: u64,
}

/// A missed discovery is retried after this, doubling up to the cap unless a watched directory
/// changes first. The floor matches the renderer's poll, so the first retry is never later than
/// today; the cap keeps a record that appears before its first timestamped line from being missed.
const UNBOUND_RECHECK_MIN: Duration = Duration::from_secs(4);
const UNBOUND_RECHECK_MAX: Duration = Duration::from_secs(30);

impl Default for TranscriptService {
    fn default() -> Self {
        Self::new(None)
    }
}

impl TranscriptService {
    pub(crate) fn new(sessions_root: Option<PathBuf>) -> Self {
        Self {
            home: home_dir(),
            store: sessions_root.map(SessionStore::at).map(Arc::new),
            cache: Arc::new(Mutex::new(HashMap::new())),
            #[cfg(test)]
            cold_read_hook: None,
        }
    }

    #[cfg(test)]
    fn at_home(home: PathBuf) -> Self {
        Self {
            home: Some(home),
            store: None,
            cache: Arc::new(Mutex::new(HashMap::new())),
            cold_read_hook: None,
        }
    }

    #[cfg(test)]
    fn at_home_with_store(home: PathBuf, store: SessionStore) -> Self {
        Self {
            home: Some(home),
            store: Some(Arc::new(store)),
            cache: Arc::new(Mutex::new(HashMap::new())),
            cold_read_hook: None,
        }
    }

    #[cfg(test)]
    fn at_home_with_hook(home: PathBuf, cold_read_hook: ColdReadHook) -> Self {
        Self {
            home: Some(home),
            store: None,
            cache: Arc::new(Mutex::new(HashMap::new())),
            cold_read_hook: Some(cold_read_hook),
        }
    }

    #[cfg(test)]
    fn read(
        &self,
        session_id: String,
        run_id: Option<u64>,
        project_path: String,
        started_at: Option<String>,
        agent_command: Option<String>,
        limit: usize,
    ) -> Result<Option<AgentTranscript>, String> {
        let scope = TranscriptScope {
            session_id,
            run_id,
            project_path,
            started_at,
            agent_command,
        };
        Ok(match self.read_changed(scope, None, limit)? {
            TranscriptRead::Transcript { transcript } => Some(*transcript),
            TranscriptRead::Unchanged { .. } | TranscriptRead::Absent => None,
        })
    }

    fn read_changed(
        &self,
        scope: TranscriptScope,
        known_revision: Option<u64>,
        limit: usize,
    ) -> Result<TranscriptRead, String> {
        let limit = limit.clamp(1, MAX_TRANSCRIPT_ENTRIES);
        let read = self.with_bound(scope, |bound| {
            if known_revision == Some(bound.revision) {
                TranscriptRead::Unchanged {
                    revision: bound.revision,
                }
            } else {
                TranscriptRead::Transcript {
                    transcript: Box::new(bound.snapshot(limit)),
                }
            }
        })?;
        Ok(read.unwrap_or(TranscriptRead::Absent))
    }

    fn activity(&self, scope: TranscriptScope) -> Result<Option<AgentActivityRead>, String> {
        self.with_bound(scope, |bound| AgentActivityRead {
            activity: bound.activity(),
            revision: bound.revision,
        })
    }

    /// Resolves the session's bound record — binding, rebinding or remembering a miss — refreshes
    /// it, and projects it. Every command shares this so each costs one stat and the appended lines.
    fn with_bound<T>(
        &self,
        scope: TranscriptScope,
        project: impl FnOnce(&BoundTranscript) -> T,
    ) -> Result<Option<T>, String> {
        let home = self
            .home
            .as_deref()
            .ok_or_else(|| "could not resolve the home directory".to_string())?;
        let session_cache = {
            let mut cache = self
                .cache
                .lock()
                .map_err(|_| "the transcript cache registry is unavailable".to_string())?;
            Arc::clone(
                cache
                    .entry(scope.session_id.clone())
                    .or_insert_with(|| Arc::new(Mutex::new(None))),
            )
        };
        let mut cached = session_cache
            .lock()
            .map_err(|_| "the transcript cache is unavailable".to_string())?;

        // Read the atomically replaced definition under this session lock so stale requests
        // converge on the latest broker run.
        let current_run = self
            .store
            .as_deref()
            .and_then(|store| store.definition(&scope.session_id));
        let effective_project = current_run
            .as_ref()
            .and_then(|run| run.cwd.as_deref())
            .unwrap_or(&scope.project_path);
        let stored_provider = current_run
            .as_ref()
            .and_then(|run| run.command.as_deref())
            .and_then(|command| provider_hint(Some(command)));
        let current_run_started_ms = current_run
            .as_ref()
            .and_then(|run| i64::try_from(run.started_at_ms).ok());
        let effective_started_ms = current_run_started_ms
            .or_else(|| scope.started_at.as_deref().and_then(parse_rfc3339_ms));
        let effective_provider =
            stored_provider.or_else(|| provider_hint(scope.agent_command.as_deref()));
        let claude_intent = current_run
            .as_ref()
            .filter(|_| stored_provider == Some(TranscriptSource::Claude))
            .and_then(|run| claude_record_intent(&run.args));
        let authoritative_run_id = current_run.as_ref().and_then(|run| run.run_id);
        let effective_run_id = authoritative_run_id.or(scope.run_id);
        let project_key = normalised_path(effective_project);
        let signature = (effective_run_id, effective_started_ms, effective_provider);

        if cached
            .as_ref()
            .is_some_and(|cached| cached.project_key() != project_key)
        {
            *cached = None;
        }

        if let Some(CachedSession::Bound(bound)) = cached.as_mut() {
            if bound.run_id.is_none() {
                bound.run_id = effective_run_id;
            }
        }
        let changed_run = cached.as_ref().and_then(|cached| match cached {
            CachedSession::Bound(bound) => match (bound.run_id, effective_run_id) {
                (Some(previous), Some(current))
                    if replaces_cached_run(previous, current, authoritative_run_id.is_some()) =>
                {
                    Some(current)
                }
                _ => None,
            },
            CachedSession::Pending(_) | CachedSession::Unbound(_) => None,
        });
        if let Some(current) = changed_run {
            let Some(CachedSession::Bound(bound)) = cached.take() else {
                unreachable!("the changed run was bound above")
            };
            let source = effective_provider.unwrap_or(bound.source);
            *cached = Some(CachedSession::Pending(PendingRebind {
                project_key: project_key.clone(),
                run_id: current,
                since_ms: current_run_started_ms
                    .unwrap_or_else(|| system_time_ms(SystemTime::now())),
                source,
                previous: bound,
            }));
        }

        let resolution = if let Some(CachedSession::Pending(pending)) = cached.as_mut() {
            if let Some(current) = effective_run_id {
                if replaces_cached_run(pending.run_id, current, authoritative_run_id.is_some()) {
                    pending.run_id = current;
                    pending.since_ms =
                        current_run_started_ms.unwrap_or_else(|| system_time_ms(SystemTime::now()));
                }
            }
            if let Some(source) = effective_provider {
                pending.source = source;
            }
            let candidate = discover_record(
                home,
                effective_project,
                Some(pending.since_ms),
                Some(pending.source),
                claude_intent.as_ref(),
                Some(&pending.previous.path),
            )?;
            if let Some(candidate) = candidate {
                if candidate.path == pending.previous.path
                    && candidate.source == pending.previous.source
                {
                    // A probable match is only mtime proximity to the new run's start. For the
                    // record this session already had open, that proves nothing until the file
                    // has actually grown past what was read; until then the run stays pending
                    // rather than showing the old conversation under a new run.
                    if candidate.binding == Binding::Probable
                        && !pending.previous.changed_since(pending.since_ms)
                    {
                        return Ok(None);
                    }
                    Some(RebindResolution::Resume(candidate.binding))
                } else {
                    Some(RebindResolution::New(candidate))
                }
            } else if claude_intent.is_none()
                && pending.previous.source == pending.source
                && pending.previous.changed_since(pending.since_ms)
            {
                Some(RebindResolution::Resume(pending.previous.binding))
            } else {
                return Ok(None);
            }
        } else {
            None
        };
        if let Some(resolution) = resolution {
            let Some(CachedSession::Pending(mut pending)) = cached.take() else {
                unreachable!("the pending transcript was resolved above")
            };
            let bound = match resolution {
                RebindResolution::New(candidate) => Box::new(BoundTranscript::open(
                    project_key.clone(),
                    Some(pending.run_id),
                    candidate,
                )?),
                RebindResolution::Resume(binding) => {
                    pending.previous.run_id = Some(pending.run_id);
                    pending.previous.binding = binding;
                    pending.previous.refresh()?;
                    pending.previous
                }
            };
            *cached = Some(CachedSession::Bound(bound));
        }

        let mut previous_wait = None;
        if let Some(CachedSession::Unbound(probe)) = cached.as_ref() {
            if probe.signature == signature {
                if !probe.due() {
                    return Ok(None);
                }
                previous_wait = Some(probe.next_after);
            }
            *cached = None;
        }
        if cached.is_none() {
            #[cfg(test)]
            if let Some(hook) = &self.cold_read_hook {
                hook(&scope.session_id);
            }
            // Snapshot before discovery, so a record created while discovery ran triggers the
            // next poll's rescan instead of waiting out the backoff.
            let watched = watched_paths(home, effective_project, effective_started_ms)
                .into_iter()
                .map(|path| {
                    let modified = modified_opt(&path);
                    (path, modified)
                })
                .collect();
            let Some(candidate) = discover_record(
                home,
                effective_project,
                effective_started_ms,
                effective_provider,
                claude_intent.as_ref(),
                None,
            )?
            else {
                *cached = Some(CachedSession::Unbound(UnboundProbe {
                    project_key,
                    signature,
                    checked_at: Instant::now(),
                    next_after: previous_wait
                        .map(|wait| (wait * 2).min(UNBOUND_RECHECK_MAX))
                        .unwrap_or(UNBOUND_RECHECK_MIN),
                    watched,
                }));
                return Ok(None);
            };
            let bound = Box::new(BoundTranscript::open(
                project_key,
                effective_run_id,
                candidate,
            )?);
            *cached = Some(CachedSession::Bound(bound));
        }

        let Some(CachedSession::Bound(bound)) = cached.as_mut() else {
            return Ok(None);
        };
        bound.refresh()?;
        Ok(Some(project(bound)))
    }
}

/// A persisted broker definition is exact, including after a broker restart resets its counter.
/// Without that definition, renderer observations from one broker are monotonic, so an older
/// delayed request must never roll the cache backward.
fn replaces_cached_run(previous: u64, current: u64, authoritative: bool) -> bool {
    if authoritative {
        current != previous
    } else {
        current > previous
    }
}

fn modified_opt(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
}

/// Keep cold discovery and parsing off the window thread; per-session locks still coalesce reads.
// The renderer sends these exact named fields (sessionId, runId, projectPath, startedAt,
// agentCommand, limit, knownRevision); grouping them into a struct would just move the same
// shape one level down without changing the Tauri command's IPC surface.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub(crate) async fn agent_transcript(
    service: tauri::State<'_, TranscriptService>,
    session_id: String,
    run_id: Option<u64>,
    project_path: String,
    started_at: Option<String>,
    agent_command: Option<String>,
    limit: usize,
    known_revision: Option<u64>,
) -> Result<TranscriptRead, String> {
    let service = (*service).clone();
    let scope = TranscriptScope {
        session_id,
        run_id,
        project_path,
        started_at,
        agent_command,
    };
    tauri::async_runtime::spawn_blocking(move || service.read_changed(scope, known_revision, limit))
        .await
        .map_err(|error| format!("transcript worker failed: {error}"))?
}

/// The activity projection alone: same cached binding, same one-stat refresh, no entry clone.
#[tauri::command]
pub(crate) async fn agent_activity(
    service: tauri::State<'_, TranscriptService>,
    session_id: String,
    run_id: Option<u64>,
    project_path: String,
    started_at: Option<String>,
    agent_command: Option<String>,
) -> Result<Option<AgentActivityRead>, String> {
    let service = (*service).clone();
    let scope = TranscriptScope {
        session_id,
        run_id,
        project_path,
        started_at,
        agent_command,
    };
    tauri::async_runtime::spawn_blocking(move || service.activity(scope))
        .await
        .map_err(|error| format!("transcript worker failed: {error}"))?
}

enum CachedSession {
    Bound(Box<BoundTranscript>),
    Pending(PendingRebind),
    Unbound(UnboundProbe),
}

impl CachedSession {
    fn project_key(&self) -> &str {
        match self {
            Self::Bound(bound) => &bound.project_key,
            Self::Pending(pending) => &pending.project_key,
            Self::Unbound(probe) => &probe.project_key,
        }
    }
}

struct PendingRebind {
    project_key: String,
    run_id: u64,
    since_ms: i64,
    source: TranscriptSource,
    previous: Box<BoundTranscript>,
}

enum RebindResolution {
    New(Candidate),
    Resume(crate::agent_transcript::Binding),
}

/// A remembered discovery miss. It is trusted while the run, its start and its provider hint stay
/// the same, none of the watched directories changed, and the recheck interval has not elapsed.
struct UnboundProbe {
    project_key: String,
    signature: (Option<u64>, Option<i64>, Option<TranscriptSource>),
    checked_at: Instant,
    next_after: Duration,
    watched: Vec<(PathBuf, Option<SystemTime>)>,
}

impl UnboundProbe {
    fn due(&self) -> bool {
        self.checked_at.elapsed() >= self.next_after
            || self
                .watched
                .iter()
                .any(|(path, modified)| modified_opt(path) != *modified)
    }
}

#[cfg(test)]
#[path = "transcript_service_cache_tests.rs"]
mod cache_tests;
#[cfg(test)]
#[path = "transcript_service_claude_tests.rs"]
mod claude_tests;
#[cfg(test)]
#[path = "transcript_service_core_tests.rs"]
mod core_tests;
#[cfg(test)]
#[path = "transcript_service_extended_tests.rs"]
mod extended_tests;
#[cfg(test)]
#[path = "transcript_service_perf_tests.rs"]
mod perf_tests;
