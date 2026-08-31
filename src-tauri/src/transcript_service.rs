//! Session-scoped discovery and incremental reading for agent-owned JSONL transcripts.
//!
//! Discovery is deliberately paid once per Talkak session. After that, the exact record path is
//! bound to the session id and only bytes appended after the last complete line are parsed.

use crate::agent_transcript::{
    collect_line, home_dir, normalised_path, AgentTranscript, Collected, TranscriptSource,
    MAX_TRANSCRIPT_ENTRIES,
};
use crate::transcript_discovery::{
    discover_record, parse_rfc3339_ms, provider_hint, system_time_ms, Candidate,
};
use crate::transcript_selection::claude_record_intent;
use session_broker::store::SessionStore;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

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

    fn read(
        &self,
        session_id: String,
        run_id: Option<u64>,
        project_path: String,
        started_at: Option<String>,
        agent_command: Option<String>,
        limit: usize,
    ) -> Result<Option<AgentTranscript>, String> {
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
                    .entry(session_id.clone())
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
            .and_then(|store| store.definition(&session_id));
        let effective_project = current_run
            .as_ref()
            .and_then(|run| run.cwd.as_deref())
            .unwrap_or(&project_path);
        let stored_provider = current_run
            .as_ref()
            .and_then(|run| run.command.as_deref())
            .and_then(|command| provider_hint(Some(command)));
        let current_run_started_ms = current_run
            .as_ref()
            .and_then(|run| i64::try_from(run.started_at_ms).ok());
        let effective_started_ms =
            current_run_started_ms.or_else(|| started_at.as_deref().and_then(parse_rfc3339_ms));
        let effective_provider =
            stored_provider.or_else(|| provider_hint(agent_command.as_deref()));
        let claude_intent = current_run
            .as_ref()
            .filter(|_| stored_provider == Some(TranscriptSource::Claude))
            .and_then(|run| claude_record_intent(&run.args));
        let authoritative_run_id = current_run.as_ref().and_then(|run| run.run_id);
        let effective_run_id = authoritative_run_id.or(run_id);
        let project_key = normalised_path(effective_project);

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
            CachedSession::Pending(_) => None,
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
                previous: Box::new(bound),
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
                    Some(RebindResolution::Resume)
                } else {
                    Some(RebindResolution::New(candidate))
                }
            } else if claude_intent.is_none()
                && pending.previous.source == pending.source
                && pending.previous.changed_since(pending.since_ms)
            {
                Some(RebindResolution::Resume)
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
                RebindResolution::New(candidate) => {
                    BoundTranscript::open(project_key.clone(), Some(pending.run_id), candidate)?
                }
                RebindResolution::Resume => {
                    pending.previous.run_id = Some(pending.run_id);
                    pending.previous.refresh()?;
                    *pending.previous
                }
            };
            *cached = Some(CachedSession::Bound(bound));
        }

        if cached.is_none() {
            #[cfg(test)]
            if let Some(hook) = &self.cold_read_hook {
                hook(&session_id);
            }
            let Some(candidate) = discover_record(
                home,
                effective_project,
                effective_started_ms,
                effective_provider,
                claude_intent.as_ref(),
                None,
            )?
            else {
                return Ok(None);
            };
            let bound = BoundTranscript::open(project_key, effective_run_id, candidate)?;
            *cached = Some(CachedSession::Bound(bound));
        }

        let CachedSession::Bound(bound) = cached
            .as_mut()
            .expect("a bound transcript was inserted above")
        else {
            return Ok(None);
        };
        bound.refresh()?;
        Ok(Some(bound.snapshot(limit.clamp(1, MAX_TRANSCRIPT_ENTRIES))))
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

/// Keep cold discovery and parsing off the window thread; per-session locks still coalesce reads.
#[tauri::command]
pub(crate) async fn agent_transcript(
    service: tauri::State<'_, TranscriptService>,
    session_id: String,
    run_id: Option<u64>,
    project_path: String,
    started_at: Option<String>,
    agent_command: Option<String>,
    limit: usize,
) -> Result<Option<AgentTranscript>, String> {
    let service = (*service).clone();
    tauri::async_runtime::spawn_blocking(move || {
        service.read(
            session_id,
            run_id,
            project_path,
            started_at,
            agent_command,
            limit,
        )
    })
    .await
    .map_err(|error| format!("transcript worker failed: {error}"))?
}

enum CachedSession {
    Bound(BoundTranscript),
    Pending(PendingRebind),
}

impl CachedSession {
    fn project_key(&self) -> &str {
        match self {
            Self::Bound(bound) => &bound.project_key,
            Self::Pending(pending) => &pending.project_key,
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
    Resume,
}

struct BoundTranscript {
    project_key: String,
    run_id: Option<u64>,
    source: TranscriptSource,
    path: PathBuf,
    collected: Collected,
    offset: u64,
    observed_len: u64,
    observed_modified: Option<SystemTime>,
    #[cfg(test)]
    parsed_lines: usize,
}

impl BoundTranscript {
    fn open(
        project_key: String,
        run_id: Option<u64>,
        candidate: Candidate,
    ) -> Result<Self, String> {
        let mut bound = Self {
            project_key,
            run_id,
            source: candidate.source,
            path: candidate.path,
            collected: Collected::new(),
            offset: 0,
            observed_len: 0,
            observed_modified: None,
            #[cfg(test)]
            parsed_lines: 0,
        };
        bound.reset_and_parse()?;
        Ok(bound)
    }

    fn changed_since(&self, since_ms: i64) -> bool {
        let Ok(metadata) = std::fs::metadata(&self.path) else {
            return false;
        };
        let advanced = metadata.len() > self.observed_len
            || (metadata.len() == self.observed_len
                && metadata.modified().ok() != self.observed_modified);
        let modified_after_launch = metadata
            .modified()
            .ok()
            .is_some_and(|value| system_time_ms(value) >= since_ms.saturating_sub(1_000));
        advanced && modified_after_launch
    }

    fn refresh(&mut self) -> Result<(), String> {
        let metadata = std::fs::metadata(&self.path)
            .map_err(|error| format!("could not inspect the agent record: {error}"))?;
        let modified = metadata.modified().ok();
        if metadata.len() < self.observed_len
            || self.offset > metadata.len()
            || (metadata.len() == self.observed_len && modified != self.observed_modified)
        {
            return self.reset_and_parse();
        }
        if metadata.len() == self.observed_len {
            return Ok(());
        }
        self.parse_through(metadata.len())?;
        self.observed_len = metadata.len();
        self.observed_modified = modified;
        Ok(())
    }

    fn reset_and_parse(&mut self) -> Result<(), String> {
        let metadata = std::fs::metadata(&self.path)
            .map_err(|error| format!("could not inspect the agent record: {error}"))?;
        self.collected = Collected::new();
        self.offset = 0;
        self.parse_through(metadata.len())?;
        self.observed_len = metadata.len();
        self.observed_modified = metadata.modified().ok();
        Ok(())
    }

    fn parse_through(&mut self, target_len: u64) -> Result<(), String> {
        let mut file = std::fs::File::open(&self.path)
            .map_err(|error| format!("could not open the agent record: {error}"))?;
        file.seek(SeekFrom::Start(self.offset))
            .map_err(|error| format!("could not seek in the agent record: {error}"))?;
        let remaining = target_len.saturating_sub(self.offset);
        let mut reader = BufReader::new(file.take(remaining));
        let mut line = Vec::new();
        loop {
            line.clear();
            let read = reader
                .read_until(b'\n', &mut line)
                .map_err(|error| format!("could not read the agent record: {error}"))?;
            if read == 0 || line.last() != Some(&b'\n') {
                break;
            }
            self.offset += read as u64;
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if let Ok(text) = std::str::from_utf8(&line) {
                collect_line(
                    self.source,
                    text,
                    &mut self.collected,
                    MAX_TRANSCRIPT_ENTRIES,
                );
            }
            #[cfg(test)]
            {
                self.parsed_lines += 1;
            }
        }
        Ok(())
    }

    fn snapshot(&self, limit: usize) -> AgentTranscript {
        self.collected.snapshot(
            self.source,
            &self.path,
            limit.clamp(1, MAX_TRANSCRIPT_ENTRIES),
        )
    }
}

#[cfg(test)]
#[path = "transcript_service_claude_tests.rs"]
mod claude_tests;
#[cfg(test)]
#[path = "transcript_service_core_tests.rs"]
mod core_tests;
#[cfg(test)]
#[path = "transcript_service_extended_tests.rs"]
mod extended_tests;
