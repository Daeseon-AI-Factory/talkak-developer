//! Provider-neutral transcript discovery paid only while a session has no bound record.

use crate::agent_transcript::{Binding, TranscriptSource};
use crate::transcript_antigravity::{
    antigravity_root, antigravity_start_ms, antigravity_transcripts,
};
use crate::transcript_line_filter::{codex_session_header, codex_session_header_prefix};
use crate::transcript_paths::{claude_project_dir_name, collect_rollouts, modified_at};
use crate::transcript_selection::{
    project_paths_match, unique_claude_resume_path, ClaudeRecordIntent,
};
use chrono::{DateTime, Utc};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone)]
pub(crate) struct Candidate {
    pub(crate) path: PathBuf,
    pub(crate) source: TranscriptSource,
    pub(crate) binding: Binding,
    started_ms: Option<i64>,
    modified_ms: i64,
}

pub(crate) fn discover_record(
    home: &Path,
    project_path: &str,
    session_started_ms: Option<i64>,
    hint: Option<TranscriptSource>,
    claude_intent: Option<&ClaudeRecordIntent>,
    excluded_path: Option<&Path>,
) -> Result<Option<Candidate>, String> {
    if matches!(
        claude_intent,
        Some(ClaudeRecordIntent::ExistingTargetUnbound)
    ) {
        return Ok(probable_claude_record(
            home,
            project_path,
            session_started_ms,
        ));
    }
    let resumes_existing = matches!(
        claude_intent,
        Some(ClaudeRecordIntent::ResumeExact(_) | ClaudeRecordIntent::CurrentProjectExact(_))
    );
    // An exact id names its record outright; only launch-time discovery needs the mtime prefilter.
    let claude_since_ms = session_started_ms.filter(|_| !resumes_existing);
    // A UUID resume can point at another worktree. Only one exact basename across Claude's
    // immediate project directories is safe; duplicate matches are deliberately ambiguous.
    let mut candidates = match claude_intent {
        Some(ClaudeRecordIntent::ResumeExact(session_id)) => {
            unique_claude_resume_path(home, session_id)
                .map(claude_candidate)
                .into_iter()
                .collect()
        }
        _ => match hint {
            Some(TranscriptSource::Claude) => {
                claude_candidates(home, project_path, claude_since_ms)
            }
            Some(TranscriptSource::Codex) => {
                codex_candidates(home, project_path, session_started_ms)?
            }
            Some(TranscriptSource::Antigravity) => antigravity_candidates(home, session_started_ms),
            None => {
                let mut records = claude_candidates(home, project_path, claude_since_ms);
                records.extend(codex_candidates(home, project_path, session_started_ms)?);
                records.extend(antigravity_candidates(home, session_started_ms));
                records
            }
        },
    };

    if let Some(ClaudeRecordIntent::CurrentProjectExact(session_id)) = claude_intent {
        candidates.retain(|candidate| candidate_stem_is(candidate, session_id));
    }

    // Resume intents may deliberately select the already-bound path. The caller recognizes that
    // identity and refreshes its incremental cache instead of reparsing it.
    if !resumes_existing {
        if let Some(excluded) = excluded_path {
            candidates.retain(|candidate| candidate.path != excluded);
        }
    }
    if let Some(started) = session_started_ms.filter(|_| !resumes_existing) {
        // The broker captures this boundary immediately before launch. One second still covers
        // filesystem timestamp rounding without admitting a visibly older pane's record.
        let earliest = started.saturating_sub(1_000);
        candidates.retain(|candidate| candidate.started_ms.is_some_and(|value| value >= earliest));
    }

    if matches!(claude_intent, Some(ClaudeRecordIntent::ForkNew)) {
        let Some(best) = candidates
            .iter()
            .map(|candidate| ownership_key(candidate, session_started_ms))
            .min()
        else {
            return Ok(None);
        };
        if candidates
            .iter()
            .filter(|candidate| ownership_key(candidate, session_started_ms) == best)
            .count()
            != 1
        {
            return Ok(None);
        }
    }

    Ok(candidates.into_iter().min_by(|left, right| {
        candidate_key(left, session_started_ms).cmp(&candidate_key(right, session_started_ms))
    }))
}

/// `--continue` and a bare or search-term `--resume` reopen a record whose first timestamp
/// predates this run, so the usual start-time proof cannot apply. The record that advanced after
/// launch is the one the agent is writing — but only when exactly one did: with two same-cwd panes
/// mtime cannot say which owns which, and staying unbound beats showing the wrong conversation.
fn probable_claude_record(
    home: &Path,
    project_path: &str,
    session_started_ms: Option<i64>,
) -> Option<Candidate> {
    session_started_ms?;
    let mut candidates = claude_candidates(home, project_path, session_started_ms);
    if candidates.len() != 1 {
        return None;
    }
    let mut candidate = candidates.pop()?;
    candidate.binding = Binding::Probable;
    Some(candidate)
}

fn ownership_key(candidate: &Candidate, target: Option<i64>) -> (u8, u64) {
    match (target, candidate.started_ms) {
        (Some(wanted), Some(started)) => (0, wanted.abs_diff(started)),
        (Some(_), None) => (1, u64::MAX),
        (None, _) => (0, 0),
    }
}

fn candidate_stem_is(candidate: &Candidate, session_id: &str) -> bool {
    candidate
        .path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .is_some_and(|stem| stem.eq_ignore_ascii_case(session_id))
}

fn candidate_key(candidate: &Candidate, target: Option<i64>) -> (u8, u64, std::cmp::Reverse<i64>) {
    match (target, candidate.started_ms) {
        (Some(wanted), Some(started)) => (
            0,
            wanted.abs_diff(started),
            std::cmp::Reverse(candidate.modified_ms),
        ),
        (Some(_), None) => (1, u64::MAX, std::cmp::Reverse(candidate.modified_ms)),
        (None, _) => (0, 0, std::cmp::Reverse(candidate.modified_ms)),
    }
}

/// The directory Claude Code writes this project's records into, whether or not it exists yet.
pub(crate) fn claude_project_dir(home: &Path, project_path: &str) -> PathBuf {
    let root = home.join(".claude/projects");
    let wanted = claude_project_dir_name(project_path);
    let mut fallback = None;
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name == wanted {
                return entry.path();
            }
            if fallback.is_none() && name.eq_ignore_ascii_case(&wanted) {
                fallback = Some(entry.path());
            }
        }
    }
    fallback.unwrap_or_else(|| root.join(wanted))
}

fn claude_candidates(
    home: &Path,
    project_path: &str,
    session_started_ms: Option<i64>,
) -> Vec<Candidate> {
    let Ok(records) = std::fs::read_dir(claude_project_dir(home, project_path)) else {
        return Vec::new();
    };
    // A record whose mtime predates the run cannot carry a first timestamp after it. Dropping it
    // here skips opening and parsing every historical record in the project on each cold poll.
    let earliest = session_started_ms.map(|started| started.saturating_sub(1_000));
    records
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("jsonl"))
        .filter(|path| {
            earliest.is_none_or(|earliest| system_time_ms(modified_at(path)) >= earliest)
        })
        .map(claude_candidate)
        .collect()
}

fn claude_candidate(path: PathBuf) -> Candidate {
    Candidate {
        modified_ms: system_time_ms(modified_at(&path)),
        started_ms: claude_start_ms(&path),
        path,
        source: TranscriptSource::Claude,
        binding: Binding::Exact,
    }
}

fn claude_start_ms(path: &Path) -> Option<i64> {
    let file = std::fs::File::open(path).ok()?;
    for line in BufReader::new(file).lines().map_while(Result::ok).take(256) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if value.get("isSidechain").and_then(|flag| flag.as_bool()) == Some(true) {
            continue;
        }
        if let Some(parsed) = value
            .get("timestamp")
            .and_then(|value| value.as_str())
            .and_then(parse_rfc3339_ms)
        {
            return Some(parsed);
        }
    }
    None
}

fn antigravity_candidates(home: &Path, session_started_ms: Option<i64>) -> Vec<Candidate> {
    let earliest = session_started_ms.map(|started| started.saturating_sub(1_000));
    antigravity_transcripts(home)
        .into_iter()
        .filter_map(|path| {
            let modified_ms = system_time_ms(modified_at(&path));
            if earliest.is_some_and(|earliest| modified_ms < earliest) {
                return None;
            }
            Some(Candidate {
                started_ms: antigravity_start_ms(&path),
                modified_ms,
                path,
                source: TranscriptSource::Antigravity,
                binding: Binding::Exact,
            })
        })
        .collect()
}

fn codex_candidates(
    home: &Path,
    project_path: &str,
    session_started_ms: Option<i64>,
) -> Result<Vec<Candidate>, String> {
    let root = home.join(".codex/sessions");
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    if let Some(started_ms) = session_started_ms {
        let mut records = Vec::new();
        for directory in codex_shard_directories(&root, started_ms) {
            collect_rollouts(&directory, &mut records, 0);
        }
        let nearby = inspect_codex_candidates(records, project_path, Some(started_ms));
        let earliest = started_ms.saturating_sub(1_000);
        if nearby
            .iter()
            .any(|candidate| candidate.started_ms.is_some_and(|value| value >= earliest))
        {
            return Ok(nearby);
        }
    }

    // A shell can stay open for days before the user starts an agent. The near-start fast path
    // deliberately falls back to the complete tree so that case keeps the previous behaviour.
    let mut records = Vec::new();
    collect_rollouts(&root, &mut records, 0);
    Ok(inspect_codex_candidates(
        records,
        project_path,
        session_started_ms,
    ))
}

fn inspect_codex_candidates(
    records: Vec<PathBuf>,
    project_path: &str,
    session_started_ms: Option<i64>,
) -> Vec<Candidate> {
    let mut records: Vec<_> = records
        .into_iter()
        .map(|path| (system_time_ms(modified_at(&path)), path))
        .collect();
    if let Some(started_ms) = session_started_ms {
        // A record whose mtime predates the run cannot pass the stricter session_meta timestamp
        // check below. Drop it before opening an 8 KiB header; a long-lived Codex installation can
        // otherwise read thousands of historical rollout headers whenever one session is cold.
        let earliest = started_ms.saturating_sub(1_000);
        records.retain(|(modified_ms, _)| *modified_ms >= earliest);
    }
    records.sort_unstable_by_key(|(modified_ms, _)| std::cmp::Reverse(*modified_ms));
    let mut candidates = Vec::new();
    for (modified_ms, path) in records {
        let Ok(file) = std::fs::File::open(&path) else {
            continue;
        };
        const HEADER_PREFIX_BYTES: u64 = 8 * 1024;
        let mut prefix = Vec::with_capacity(HEADER_PREFIX_BYTES as usize);
        if file
            .take(HEADER_PREFIX_BYTES)
            .read_to_end(&mut prefix)
            .is_err()
        {
            continue;
        }
        let prefix = String::from_utf8_lossy(&prefix);
        let header = codex_session_header_prefix(&prefix)
            .map(|header| {
                (
                    header.cwd.into_owned(),
                    header.is_user_thread,
                    header.timestamp.map(|value| value.into_owned()),
                )
            })
            .or_else(|| {
                let file = std::fs::File::open(&path).ok()?;
                let mut first = String::new();
                BufReader::new(file).read_line(&mut first).ok()?;
                codex_session_header(&first).map(|header| {
                    (
                        header.cwd.into_owned(),
                        header.is_user_thread,
                        header.timestamp.map(|value| value.into_owned()),
                    )
                })
            });
        let Some(header) = header else {
            continue;
        };
        if !header.1 || !project_paths_match(&header.0, project_path) {
            continue;
        }
        candidates.push(Candidate {
            started_ms: header.2.as_deref().and_then(parse_rfc3339_ms),
            modified_ms,
            path,
            source: TranscriptSource::Codex,
            binding: Binding::Exact,
        });
        if session_started_ms.is_none() {
            break;
        }
    }
    candidates
}

/// Codex shards rollouts by launch date. The folder can be one day either side of the UTC
/// timestamp around a timezone boundary, so a near-start search inspects those three tiny shards
/// instead of every historical record. Header, cwd, and start-time checks remain authoritative.
pub(crate) fn codex_shard_directories(root: &Path, started_ms: i64) -> Vec<PathBuf> {
    const DAY_MS: i64 = 86_400_000;
    let mut directories = Vec::with_capacity(3);
    for offset in [-DAY_MS, 0, DAY_MS] {
        let Some(timestamp) =
            DateTime::<Utc>::from_timestamp_millis(started_ms.saturating_add(offset))
        else {
            continue;
        };
        let directory = root
            .join(timestamp.format("%Y").to_string())
            .join(timestamp.format("%m").to_string())
            .join(timestamp.format("%d").to_string());
        if !directories.contains(&directory) {
            directories.push(directory);
        }
    }
    directories
}

/// The directories whose mtime moves when a new record could have appeared for this project. A
/// negative discovery result stays cached until one of them changes or its recheck interval ends.
pub(crate) fn watched_paths(
    home: &Path,
    project_path: &str,
    started_ms: Option<i64>,
) -> Vec<PathBuf> {
    let mut watched = vec![
        home.join(".claude/projects"),
        claude_project_dir(home, project_path),
        antigravity_root(home),
    ];
    let codex_root = home.join(".codex/sessions");
    match started_ms {
        Some(started_ms) => watched.extend(codex_shard_directories(&codex_root, started_ms)),
        None => watched.push(codex_root),
    }
    watched
}

pub(crate) fn provider_hint(command: Option<&str>) -> Option<TranscriptSource> {
    let executable = command?
        .replace('\\', "/")
        .rsplit('/')
        .next()?
        .to_ascii_lowercase();
    let executable = [".exe", ".cmd", ".bat"]
        .into_iter()
        .find_map(|suffix| executable.strip_suffix(suffix))
        .unwrap_or(&executable);
    match executable {
        "claude" | "claude-code" => Some(TranscriptSource::Claude),
        "codex" => Some(TranscriptSource::Codex),
        "agy" | "antigravity" => Some(TranscriptSource::Antigravity),
        _ => None,
    }
}

pub(crate) fn system_time_ms(value: SystemTime) -> i64 {
    value
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}

pub(crate) fn parse_rfc3339_ms(value: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|timestamp| timestamp.timestamp_millis())
}
