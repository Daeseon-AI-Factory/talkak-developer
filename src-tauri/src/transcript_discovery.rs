//! Provider-neutral transcript discovery paid only while a session has no bound record.

use crate::agent_transcript::{
    claude_project_dir_name, collect_rollouts, modified_at, TranscriptSource,
};
use crate::transcript_line_filter::{codex_session_header, codex_session_header_prefix};
use crate::transcript_selection::{
    project_paths_match, unique_claude_resume_path, ClaudeRecordIntent,
};
use chrono::DateTime;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone)]
pub(crate) struct Candidate {
    pub(crate) path: PathBuf,
    pub(crate) source: TranscriptSource,
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
        return Ok(None);
    }
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
            Some(TranscriptSource::Claude) => claude_candidates(home, project_path),
            Some(TranscriptSource::Codex) => {
                codex_candidates(home, project_path, session_started_ms)?
            }
            None => {
                let mut records = claude_candidates(home, project_path);
                records.extend(codex_candidates(home, project_path, session_started_ms)?);
                records
            }
        },
    };

    if let Some(intent) = claude_intent {
        match intent {
            ClaudeRecordIntent::ResumeExact(_) => {}
            ClaudeRecordIntent::CurrentProjectExact(session_id) => {
                candidates.retain(|candidate| candidate_stem_is(candidate, session_id));
            }
            ClaudeRecordIntent::ExistingTargetUnbound => return Ok(None),
            ClaudeRecordIntent::ForkNew => {}
        }
    }

    let resumes_existing = matches!(
        claude_intent,
        Some(ClaudeRecordIntent::ResumeExact(_) | ClaudeRecordIntent::CurrentProjectExact(_))
    );
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

fn claude_candidates(home: &Path, project_path: &str) -> Vec<Candidate> {
    let root = home.join(".claude/projects");
    let wanted = claude_project_dir_name(project_path);
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut exact = None;
    let mut fallback = None;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name == wanted {
            exact = Some(entry.path());
            break;
        }
        if fallback.is_none() && name.eq_ignore_ascii_case(&wanted) {
            fallback = Some(entry.path());
        }
    }
    let Some(directory) = exact.or(fallback) else {
        return Vec::new();
    };
    let Ok(records) = std::fs::read_dir(directory) else {
        return Vec::new();
    };
    records
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("jsonl"))
        .map(claude_candidate)
        .collect()
}

fn claude_candidate(path: PathBuf) -> Candidate {
    Candidate {
        modified_ms: system_time_ms(modified_at(&path)),
        started_ms: claude_start_ms(&path),
        path,
        source: TranscriptSource::Claude,
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

fn codex_candidates(
    home: &Path,
    project_path: &str,
    session_started_ms: Option<i64>,
) -> Result<Vec<Candidate>, String> {
    let root = home.join(".codex/sessions");
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut records = Vec::new();
    collect_rollouts(&root, &mut records, 0);
    let mut records: Vec<_> = records
        .into_iter()
        .map(|path| (system_time_ms(modified_at(&path)), path))
        .collect();
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
        });
        if session_started_ms.is_none() {
            break;
        }
    }
    Ok(candidates)
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
