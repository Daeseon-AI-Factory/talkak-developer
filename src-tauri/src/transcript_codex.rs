//! Codex record adapter: `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl`.
//!
//! Records are `{timestamp, type, payload}`. Conversation turns are `response_item` payloads of
//! type `message`; tool calls are `function_call`, `custom_tool_call` or `local_shell_call`
//! payloads carrying `name` and `call_id`; turn boundaries and running token totals arrive as
//! `event_msg` payloads. Tool outputs are deliberately not read — they are the largest records and
//! the next turn event already tells the state machine the tool finished.

use crate::agent_transcript::{strip_harness_wrapper, Collected, TranscriptEntry};
use crate::transcript_usage::{usage_field, UsageSample};
use serde_json::Value;

const GROUP: &str = "codex-assistant-turn";
/// The collaboration tool that pauses the turn until the person answers.
const ASKS_PERSON: &str = "request_user_input";

pub(crate) fn collect_codex_value(value: &Value, collected: &mut Collected, limit: usize) {
    let kind = value.get("type").and_then(Value::as_str);
    let Some(payload) = value.get("payload") else {
        return;
    };
    let payload_kind = payload.get("type").and_then(Value::as_str);
    let at = value.get("timestamp").and_then(Value::as_str);
    match (kind, payload_kind) {
        (Some("response_item"), Some("message")) => collect_message(payload, at, collected, limit),
        (
            Some("response_item"),
            Some(call @ ("function_call" | "custom_tool_call" | "local_shell_call")),
        ) => {
            let name = payload
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty())
                .unwrap_or(if call == "local_shell_call" {
                    "shell"
                } else {
                    "tool"
                });
            let call_id = payload.get("call_id").and_then(Value::as_str);
            collected.attach_tool(GROUP, name, Vec::new(), at.map(str::to_string), limit);
            collected
                .activity_mut()
                .tool_started(call_id, name, name == ASKS_PERSON, at);
        }
        (Some("event_msg"), Some("task_started")) => collected.activity_mut().prompt(at),
        (Some("event_msg"), Some("task_complete")) => collected.activity_mut().turn_done(at),
        (Some("event_msg"), Some("turn_aborted")) => collected.activity_mut().turn_aborted(at),
        (Some("event_msg"), Some("token_count")) => {
            // `total_token_usage` is the session's running total, not a per-reply delta.
            if let Some(total) = payload
                .get("info")
                .and_then(|info| info.get("total_token_usage"))
            {
                collected.replace_usage(UsageSample {
                    input_tokens: usage_field(total, "input_tokens"),
                    output_tokens: usage_field(total, "output_tokens"),
                    cache_read_tokens: usage_field(total, "cached_input_tokens"),
                    cache_creation_tokens: usage_field(total, "cache_write_input_tokens"),
                });
            }
        }
        _ => {}
    }
}

fn collect_message(payload: &Value, at: Option<&str>, collected: &mut Collected, limit: usize) {
    let role = match payload.get("role").and_then(Value::as_str) {
        Some(role @ ("user" | "assistant")) => role,
        _ => return,
    };
    let mut text = String::new();
    if let Some(blocks) = payload.get("content").and_then(Value::as_array) {
        for block in blocks {
            if matches!(
                block.get("type").and_then(Value::as_str),
                Some("input_text" | "output_text" | "text")
            ) {
                if let Some(value) = block.get("text").and_then(Value::as_str) {
                    if !text.is_empty() {
                        text.push_str("\n\n");
                    }
                    text.push_str(value);
                }
            }
        }
    }
    let text = strip_harness_wrapper(&text);
    if text.is_empty() {
        return;
    }
    let entry = TranscriptEntry::new(role, text, at.map(str::to_string));
    if role == "user" {
        collected.push(entry, limit);
        collected.close_group();
        collected.activity_mut().prompt(at);
    } else {
        // Codex replies stay separate entries; only the tool calls that preceded a reply fold in.
        collected.push_or_fill(entry, GROUP, limit);
        collected.activity_mut().progress(at);
    }
}

#[cfg(test)]
mod tests {
    use crate::agent_transcript::{
        collect_line, Collected, TranscriptSource, MAX_TRANSCRIPT_ENTRIES,
    };
    use crate::transcript_activity::ActivityState;
    use std::path::Path;

    fn collect(lines: &[&str]) -> Collected {
        let mut collected = Collected::new();
        for line in lines {
            collect_line(
                TranscriptSource::Codex,
                line,
                &mut collected,
                MAX_TRANSCRIPT_ENTRIES,
            );
        }
        collected
    }

    const TURN: [&str; 9] = [
        r#"{"timestamp":"2026-08-30T00:04:57.000Z","type":"session_meta","payload":{"cwd":"C:/work/app","thread_source":"user"}}"#,
        r#"{"timestamp":"2026-08-30T00:04:57.252Z","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1788048297}}"#,
        r#"{"timestamp":"2026-08-30T00:04:57.300Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>cwd</environment_context>"},{"type":"input_text","text":"list the files"}]}}"#,
        r#"{"timestamp":"2026-08-30T00:05:07.323Z","type":"response_item","payload":{"type":"custom_tool_call","id":"ctc_1","status":"completed","call_id":"call_1","name":"exec","input":"ls"}}"#,
        r#"{"timestamp":"2026-08-30T00:05:07.500Z","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"call_1","output":"a.rs\nb.rs"}}"#,
        r#"{"timestamp":"2026-08-30T00:05:07.649Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":18004,"cached_input_tokens":11008,"cache_write_input_tokens":0,"output_tokens":599,"reasoning_output_tokens":432,"total_tokens":18603},"last_token_usage":{"input_tokens":18004}},"rate_limits":{}}}"#,
        r#"{"timestamp":"2026-08-30T00:06:31.762Z","type":"response_item","payload":{"type":"function_call","id":"fc_1","name":"spawn_agent","namespace":"collaboration","arguments":"{\"task_name\":\"audit\"}","call_id":"call_2"}}"#,
        r#"{"timestamp":"2026-08-30T00:06:40.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Two files: a.rs and b.rs."}]}}"#,
        r#"{"timestamp":"2026-08-30T00:06:41.000Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1","last_agent_message":"Two files: a.rs and b.rs."}}"#,
    ];

    #[test]
    fn tool_calls_fold_into_the_reply_that_follows_them() {
        let transcript = collect(&TURN).finish("codex", Path::new("rollout.jsonl"));
        assert_eq!(transcript.total_entries, 2);
        assert_eq!(transcript.entries[0].role, "user");
        assert_eq!(transcript.entries[0].text, "list the files");
        assert_eq!(transcript.entries[1].role, "assistant");
        assert_eq!(transcript.entries[1].text, "Two files: a.rs and b.rs.");
        assert_eq!(transcript.entries[1].tools, vec!["exec", "spawn_agent"]);
        assert!(transcript.entries[1].decisions.is_empty());
        assert_eq!(
            transcript.entries[1].at.as_deref(),
            Some("2026-08-30T00:06:40.000Z")
        );
    }

    #[test]
    fn activity_follows_turn_events_and_tool_calls() {
        let states = [
            ActivityState::Idle,
            ActivityState::Thinking,
            ActivityState::Thinking,
            ActivityState::Working,
            ActivityState::Working,
            ActivityState::Working,
            ActivityState::Working,
            ActivityState::Working,
            ActivityState::Done,
        ];
        let mut collected = Collected::new();
        for (line, expected) in TURN.iter().zip(states) {
            collect_line(
                TranscriptSource::Codex,
                line,
                &mut collected,
                MAX_TRANSCRIPT_ENTRIES,
            );
            assert_eq!(collected.activity().state, expected, "after {line}");
        }
        let activity = collected.activity();
        assert_eq!(activity.last_tool.as_deref(), Some("spawn_agent"));
        assert_eq!(activity.at.as_deref(), Some("2026-08-30T00:06:41.000Z"));

        let aborted = collect(&[
            TURN[1],
            r#"{"timestamp":"2026-08-30T00:07:00.000Z","type":"event_msg","payload":{"type":"turn_aborted","turn_id":"turn-2","reason":"interrupted"}}"#,
        ]);
        assert_eq!(aborted.activity().state, ActivityState::Idle);
    }

    #[test]
    fn a_question_to_the_person_waits_and_a_bare_shell_call_is_named() {
        let collected = collect(&[
            TURN[1],
            r#"{"timestamp":"t","type":"response_item","payload":{"type":"local_shell_call","call_id":"call_9","action":{"type":"exec","command":["ls"]}}}"#,
            r#"{"timestamp":"t","type":"response_item","payload":{"type":"function_call","call_id":"call_10","name":"request_user_input","arguments":"{}"}}"#,
        ]);
        let activity = collected.activity();
        assert_eq!(activity.state, ActivityState::NeedsInput);
        assert_eq!(activity.last_tool.as_deref(), Some("request_user_input"));
        let transcript = collected.finish("codex", Path::new("rollout.jsonl"));
        assert_eq!(
            transcript.entries[0].tools,
            vec!["shell", "request_user_input"]
        );
    }

    #[test]
    fn the_running_token_total_replaces_rather_than_sums() {
        let mut collected = collect(&TURN);
        let usage = collected
            .clone()
            .finish("codex", Path::new("rollout.jsonl"))
            .usage
            .expect("codex records carry token counts");
        assert_eq!(usage.input_tokens, 18_004);
        assert_eq!(usage.cache_read_tokens, 11_008);
        assert_eq!(usage.output_tokens, 599);
        assert_eq!(usage.messages, 1);

        collect_line(
            TranscriptSource::Codex,
            r#"{"timestamp":"t","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":23111,"cached_input_tokens":9984,"cache_write_input_tokens":5,"output_tokens":1168}}}}"#,
            &mut collected,
            MAX_TRANSCRIPT_ENTRIES,
        );
        let usage = collected
            .finish("codex", Path::new("rollout.jsonl"))
            .usage
            .unwrap();
        assert_eq!(usage.input_tokens, 23_111);
        assert_eq!(usage.cache_creation_tokens, 5);
        assert_eq!(usage.messages, 2);
    }
}
