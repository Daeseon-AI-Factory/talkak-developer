//! Which agent record a session was showing, kept on disk beside the broker's own session files.
//!
//! The transcript service binds a session to a record in memory only; after a reboot or a broker
//! replacement that knowledge is gone, and a restored shell has no way to pick its conversation
//! back up. This file remembers enough to build the agent's own resume command once the shell is
//! back — and remembers that it did, so a restored run is resumed exactly once.

use crate::agent_transcript::TranscriptSource;
use serde::{Deserialize, Serialize};
use session_broker::store::{encode_name, now_ms};
use std::path::{Path, PathBuf};

const EXTENSION: &str = "bind";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentBinding {
    /// `claude`, `codex`, `antigravity` — the agent's own name, which is also the recipe key.
    pub source: String,
    pub record_path: String,
    /// What the agent's CLI accepts to reopen this record: Claude's session UUID (the file
    /// stem), Codex's session UUID (the tail of its rollout file name).
    pub record_id: String,
    pub bound_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resumed_run_id: Option<u64>,
}

/// A resume recipe per agent name, `{id}` standing for the record id. The renderer keeps these
/// in settings and passes them along; these are the defaults it starts from.
pub(crate) fn default_recipe(source: &str) -> Option<&'static str> {
    match source {
        "claude" => Some("claude -r {id}"),
        "codex" => Some("codex resume {id}"),
        _ => None,
    }
}

pub(crate) fn source_name(source: TranscriptSource) -> &'static str {
    match source {
        TranscriptSource::Claude => "claude",
        TranscriptSource::Codex => "codex",
        TranscriptSource::Antigravity => "antigravity",
    }
}

/// The id an agent's CLI takes for a record file.
pub(crate) fn record_id(source: TranscriptSource, path: &Path) -> String {
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    match source {
        // rollout-2026-03-05T18-48-38-<uuid>.jsonl: the UUID is the last 36 characters.
        TranscriptSource::Codex if stem.len() > 36 && looks_like_uuid(&stem[stem.len() - 36..]) => {
            stem[stem.len() - 36..].to_owned()
        }
        _ => stem.to_owned(),
    }
}

fn looks_like_uuid(text: &str) -> bool {
    let parts: Vec<&str> = text.split('-').collect();
    parts.len() == 5
        && parts
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(part, len)| part.len() == len && part.chars().all(|c| c.is_ascii_hexdigit()))
}

fn binding_path(sessions_dir: &Path, session_id: &str) -> PathBuf {
    sessions_dir.join(format!("{}.{EXTENSION}", encode_name(session_id)))
}

/// Remember the record a session is bound to. A rebinding to the same record keeps its resume
/// marker; a different record starts fresh.
pub(crate) fn remember(
    sessions_dir: Option<&Path>,
    session_id: &str,
    source: TranscriptSource,
    record_path: &Path,
) {
    let Some(dir) = sessions_dir else {
        return;
    };
    let path = binding_path(dir, session_id);
    let record_path_text = record_path.to_string_lossy().into_owned();
    let previous = load_at(&path);
    if previous
        .as_ref()
        .is_some_and(|known| known.record_path == record_path_text)
    {
        return;
    }
    let binding = AgentBinding {
        source: source_name(source).to_owned(),
        record_path: record_path_text,
        record_id: record_id(source, record_path),
        bound_at_ms: now_ms(),
        resumed_run_id: None,
    };
    let _ = std::fs::create_dir_all(dir);
    if let Ok(encoded) = serde_json::to_vec_pretty(&binding) {
        let _ = std::fs::write(path, encoded);
    }
}

pub(crate) fn load(sessions_dir: Option<&Path>, session_id: &str) -> Option<AgentBinding> {
    load_at(&binding_path(sessions_dir?, session_id))
}

fn load_at(path: &Path) -> Option<AgentBinding> {
    let raw = std::fs::read(path).ok()?;
    serde_json::from_slice(&raw).ok()
}

/// Reserve or release this run's resume. Reserving before the line is typed is what keeps a
/// second caller from typing it too while the first waits for the shell; a write that then fails
/// releases the reservation so the next attempt may try again.
pub(crate) fn set_resumed(sessions_dir: Option<&Path>, session_id: &str, run_id: Option<u64>) {
    let Some(dir) = sessions_dir else {
        return;
    };
    let path = binding_path(dir, session_id);
    let Some(mut binding) = load_at(&path) else {
        return;
    };
    binding.resumed_run_id = run_id;
    if let Ok(encoded) = serde_json::to_vec_pretty(&binding) {
        let _ = std::fs::write(path, encoded);
    }
}

pub(crate) fn mark_resumed(sessions_dir: Option<&Path>, session_id: &str, run_id: u64) {
    set_resumed(sessions_dir, session_id, Some(run_id));
}

pub(crate) fn forget(sessions_dir: Option<&Path>, session_id: &str) {
    if let Some(dir) = sessions_dir {
        let _ = std::fs::remove_file(binding_path(dir, session_id));
    }
}

/// The line to type into a restored shell, from the recipe for the binding's agent. An empty or
/// missing recipe means "reopen the shell, resume nothing" — what Antigravity gets by default.
pub(crate) fn resume_command(
    binding: &AgentBinding,
    recipes: &[(String, String)],
) -> Option<String> {
    let recipe = recipes
        .iter()
        .find(|(name, _)| name == &binding.source)
        .map(|(_, recipe)| recipe.as_str())
        .or_else(|| default_recipe(&binding.source))?;
    let recipe = recipe.trim();
    if recipe.is_empty() {
        return None;
    }
    Some(recipe.replace("{id}", &binding.record_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_ids_follow_each_agents_file_naming() {
        assert_eq!(
            record_id(
                TranscriptSource::Claude,
                Path::new("/h/.claude/projects/-x/11111111-1111-4111-8111-111111111111.jsonl")
            ),
            "11111111-1111-4111-8111-111111111111"
        );
        assert_eq!(
            record_id(
                TranscriptSource::Codex,
                Path::new(
                    "/h/.codex/sessions/2026/03/05/rollout-2026-03-05T18-48-38-019cbd66-38a2-7060-87cc-952f24afd35d.jsonl"
                )
            ),
            "019cbd66-38a2-7060-87cc-952f24afd35d"
        );
        assert_eq!(
            record_id(TranscriptSource::Codex, Path::new("/h/odd-name.jsonl")),
            "odd-name"
        );
    }

    #[test]
    fn a_binding_is_remembered_resumed_once_and_replaced_by_a_new_record() {
        let temp = tempfile::tempdir().unwrap();
        let dir = Some(temp.path());
        let record = Path::new("/h/.claude/projects/-x/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl");
        remember(dir, "session-1", TranscriptSource::Claude, record);
        let binding = load(dir, "session-1").unwrap();
        assert_eq!(binding.source, "claude");
        assert_eq!(binding.record_id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        assert_eq!(binding.resumed_run_id, None);

        mark_resumed(dir, "session-1", 7);
        assert_eq!(load(dir, "session-1").unwrap().resumed_run_id, Some(7));
        // A failed write releases the reservation so the next attempt may try again.
        set_resumed(dir, "session-1", None);
        assert_eq!(load(dir, "session-1").unwrap().resumed_run_id, None);
        mark_resumed(dir, "session-1", 7);
        // The same record again keeps the marker; a new record starts over.
        remember(dir, "session-1", TranscriptSource::Claude, record);
        assert_eq!(load(dir, "session-1").unwrap().resumed_run_id, Some(7));
        remember(
            dir,
            "session-1",
            TranscriptSource::Codex,
            Path::new("/h/rollout-2026-03-05T18-48-38-019cbd66-38a2-7060-87cc-952f24afd35d.jsonl"),
        );
        let rebound = load(dir, "session-1").unwrap();
        assert_eq!(rebound.source, "codex");
        assert_eq!(rebound.resumed_run_id, None);

        forget(dir, "session-1");
        assert!(load(dir, "session-1").is_none());
    }

    #[test]
    fn the_resume_line_comes_from_the_recipe_and_an_empty_recipe_means_none() {
        let binding = AgentBinding {
            source: "claude".into(),
            record_path: String::new(),
            record_id: "abc".into(),
            bound_at_ms: 0,
            resumed_run_id: None,
        };
        assert_eq!(
            resume_command(&binding, &[]).as_deref(),
            Some("claude -r abc")
        );
        let custom = vec![(
            "claude".to_string(),
            "claude --resume {id} --verbose".to_string(),
        )];
        assert_eq!(
            resume_command(&binding, &custom).as_deref(),
            Some("claude --resume abc --verbose")
        );
        let off = vec![("claude".to_string(), "   ".to_string())];
        assert_eq!(resume_command(&binding, &off), None);
        let antigravity = AgentBinding {
            source: "antigravity".into(),
            ..binding
        };
        assert_eq!(resume_command(&antigravity, &[]), None);
    }
}
