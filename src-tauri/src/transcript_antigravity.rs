//! Antigravity (`agy`) record adapter:
//! `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`.
//!
//! Records are flat `{step_index, source, type, status, created_at, content, ...}` objects. The
//! person's turn is `USER_INPUT`, whose content wraps the typed text in `<USER_REQUEST>` alongside
//! IDE metadata; the agent's turn is `PLANNER_RESPONSE` with `content` text and `tool_calls[]`.
//! Tool outputs are their own record types (`VIEW_FILE`, `RUN_COMMAND`, ...) and are not read.
//! The record carries no working directory, so discovery can only use launch-time proximity.

use crate::agent_transcript::{strip_harness_wrapper, Collected, TranscriptEntry};
use crate::transcript_discovery::parse_rfc3339_ms;
use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

const GROUP: &str = "antigravity-assistant-turn";
const TRANSCRIPT_SUFFIX: [&str; 3] = [".system_generated", "logs", "transcript.jsonl"];

pub(crate) fn collect_antigravity_value(value: &Value, collected: &mut Collected, limit: usize) {
    let at = value.get("created_at").and_then(Value::as_str);
    let content = value.get("content").and_then(Value::as_str).unwrap_or("");
    match value.get("type").and_then(Value::as_str) {
        Some("USER_INPUT") => {
            let text = user_request_text(content);
            if text.is_empty() {
                return;
            }
            collected.push(
                TranscriptEntry::new("user", text, at.map(str::to_string)),
                limit,
            );
            collected.close_group();
            collected.activity_mut().prompt(at);
        }
        Some("PLANNER_RESPONSE") => {
            let text = strip_harness_wrapper(content);
            let tools: Vec<&str> = value
                .get("tool_calls")
                .and_then(Value::as_array)
                .map(|calls| calls.iter().filter_map(tool_name).collect())
                .unwrap_or_default();
            if !text.is_empty() {
                collected.push_or_fill(
                    TranscriptEntry::new("assistant", text, at.map(str::to_string)),
                    GROUP,
                    limit,
                );
            }
            if tools.is_empty() {
                // Words with no further tool call are the answer to the request.
                collected.activity_mut().turn_done(at);
                return;
            }
            for name in tools {
                collected.attach_tool(GROUP, name, Vec::new(), at.map(str::to_string), limit);
                collected.activity_mut().tool_started(None, name, false, at);
            }
        }
        _ => {}
    }
}

fn tool_name(call: &Value) -> Option<&str> {
    ["name", "function_name", "tool_name"]
        .into_iter()
        .find_map(|key| call.get(key).and_then(Value::as_str))
        .filter(|name| !name.is_empty())
}

/// The typed request inside the IDE's envelope, or the plain content when there is no envelope.
fn user_request_text(content: &str) -> String {
    const OPEN: &str = "<USER_REQUEST>";
    const CLOSE: &str = "</USER_REQUEST>";
    if let Some(start) = content.find(OPEN) {
        let inner = &content[start + OPEN.len()..];
        let end = inner.find(CLOSE).unwrap_or(inner.len());
        return inner[..end].trim().to_string();
    }
    strip_harness_wrapper(content)
}

pub(crate) fn antigravity_root(home: &Path) -> PathBuf {
    home.join(".gemini").join("antigravity-cli").join("brain")
}

/// Every session record under the brain directory, in its fixed one-level layout.
pub(crate) fn antigravity_transcripts(home: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(antigravity_root(home)) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|entry| {
            TRANSCRIPT_SUFFIX
                .iter()
                .fold(entry.path(), |path, segment| path.join(segment))
        })
        .filter(|path| path.is_file())
        .collect()
}

/// The first `created_at` in the head of the record, as milliseconds since the epoch.
pub(crate) fn antigravity_start_ms(path: &Path) -> Option<i64> {
    let file = std::fs::File::open(path).ok()?;
    for line in BufReader::new(file).lines().map_while(Result::ok).take(16) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(parsed) = value
            .get("created_at")
            .and_then(Value::as_str)
            .and_then(parse_rfc3339_ms)
        {
            return Some(parsed);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_transcript::{collect_line, TranscriptSource, MAX_TRANSCRIPT_ENTRIES};
    use crate::transcript_activity::ActivityState;

    const TURN: [&str; 5] = [
        r#"{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","created_at":"2026-06-12T10:00:00Z","content":"<USER_REQUEST>\nBuild this\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-06-12T10:00:00Z.\n</ADDITIONAL_METADATA>"}"#,
        r#"{"step_index":1,"source":"SYSTEM","type":"EPHEMERAL_MESSAGE","status":"DONE","created_at":"2026-06-12T10:00:00Z","content":"reminders the person never typed"}"#,
        r#"{"step_index":2,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-06-12T10:01:00Z","content":"","thinking":"internal","tool_calls":[{"name":"view_file","args":{"AbsolutePath":"\"/x/a.rs\""}},{"function_name":"run_command","args":{}}]}"#,
        r#"{"step_index":3,"source":"MODEL","type":"VIEW_FILE","status":"DONE","created_at":"2026-06-12T10:01:10Z","content":"file body the reader never shows"}"#,
        r#"{"step_index":4,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-06-12T10:02:00Z","content":"Done","tool_calls":[]}"#,
    ];

    fn collect(lines: &[&str]) -> Collected {
        let mut collected = Collected::new();
        for line in lines {
            collect_line(
                TranscriptSource::Antigravity,
                line,
                &mut collected,
                MAX_TRANSCRIPT_ENTRIES,
            );
        }
        collected
    }

    #[test]
    fn user_request_and_planner_tools_become_one_turn_each() {
        let transcript = collect(&TURN).finish("antigravity", Path::new("transcript.jsonl"));
        assert_eq!(transcript.total_entries, 2);
        assert_eq!(transcript.entries[0].role, "user");
        assert_eq!(transcript.entries[0].text, "Build this");
        assert_eq!(transcript.entries[1].role, "assistant");
        assert_eq!(transcript.entries[1].text, "Done");
        assert_eq!(
            transcript.entries[1].tools,
            vec!["view_file", "run_command"]
        );
        assert_eq!(
            transcript.last_activity.as_deref(),
            Some("2026-06-12T10:02:00Z")
        );
        assert!(transcript.usage.is_none(), "agy records no token counts");
    }

    #[test]
    fn activity_moves_from_prompt_through_tools_to_done() {
        let states = [
            ActivityState::Thinking,
            ActivityState::Thinking,
            ActivityState::Working,
            ActivityState::Working,
            ActivityState::Done,
        ];
        let mut collected = Collected::new();
        for (line, expected) in TURN.iter().zip(states) {
            collect_line(
                TranscriptSource::Antigravity,
                line,
                &mut collected,
                MAX_TRANSCRIPT_ENTRIES,
            );
            assert_eq!(collected.activity().state, expected, "after {line}");
        }
        assert_eq!(
            collected.activity().last_tool.as_deref(),
            Some("run_command")
        );
    }

    #[test]
    fn plain_content_without_an_envelope_is_the_request_itself() {
        assert_eq!(user_request_text("just words"), "just words");
        assert_eq!(user_request_text("<USER_REQUEST>a</USER_REQUEST>tail"), "a");
        assert_eq!(
            user_request_text("<USER_REQUEST>unterminated"),
            "unterminated"
        );
    }

    #[test]
    fn discovery_walks_the_fixed_brain_layout_and_reads_the_first_timestamp() {
        let temp = tempfile::TempDir::new().unwrap();
        let session = antigravity_root(temp.path()).join("0ff9a9e9/.system_generated/logs");
        std::fs::create_dir_all(&session).unwrap();
        let path = session.join("transcript.jsonl");
        std::fs::write(&path, format!("{}\n{}\n", TURN[0], TURN[2])).unwrap();
        // A stray file at the wrong depth is not a session.
        std::fs::write(antigravity_root(temp.path()).join("transcript.jsonl"), "").unwrap();
        std::fs::create_dir_all(antigravity_root(temp.path()).join("empty")).unwrap();

        assert_eq!(antigravity_transcripts(temp.path()), vec![path.clone()]);
        assert_eq!(
            antigravity_start_ms(&path),
            parse_rfc3339_ms("2026-06-12T10:00:00Z")
        );
        assert_eq!(
            antigravity_transcripts(Path::new("/nowhere")),
            Vec::<PathBuf>::new()
        );
    }
}
