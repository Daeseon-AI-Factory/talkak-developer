//! Cheap first pass for agent JSONL records.
//!
//! Agent records contain large tool and telemetry payloads that can never become conversation
//! turns. Deserialising every one into `serde_json::Value` made a cold read spend most of its time
//! allocating data it immediately discarded. This borrowed envelope validates each JSON record
//! and only lets the record kinds a projection uses reach the full parser: conversation turns,
//! tool calls (for the per-turn tool list and the activity state), turn boundaries and token
//! totals. Tool outputs — the largest records — never pass.

use crate::agent_transcript::TranscriptSource;
use serde::Deserialize;
use std::borrow::Cow;

#[derive(Deserialize)]
struct RecordEnvelope<'a> {
    #[serde(rename = "type", borrow)]
    kind: Option<Cow<'a, str>>,
    #[serde(borrow)]
    payload: Option<PayloadEnvelope<'a>>,
}

#[derive(Deserialize)]
struct PayloadEnvelope<'a> {
    #[serde(rename = "type", borrow)]
    kind: Option<Cow<'a, str>>,
    #[serde(borrow)]
    role: Option<Cow<'a, str>>,
}

pub(crate) fn is_relevant(source: TranscriptSource, line: &str) -> bool {
    if let Some(relevant) = compact_record_relevance(source, line) {
        return relevant;
    }
    let Ok(record) = serde_json::from_str::<RecordEnvelope<'_>>(line) else {
        return false;
    };
    match source {
        TranscriptSource::Claude => matches!(record.kind.as_deref(), Some("user" | "assistant")),
        TranscriptSource::Codex => {
            let (Some(kind), Some(payload)) = (record.kind.as_deref(), record.payload.as_ref())
            else {
                return false;
            };
            payload.kind.as_deref().is_some_and(|payload_kind| {
                codex_record_relevant(kind, payload_kind, payload.role.as_deref())
            })
        }
        TranscriptSource::Antigravity => matches!(
            record.kind.as_deref(),
            Some("USER_INPUT" | "PLANNER_RESPONSE")
        ),
    }
}

/// Which Codex `(record type, payload type)` pairs the projection reads. `role` is `None` when the
/// caller has not established it yet and is only consulted for conversation messages.
fn codex_record_relevant(kind: &str, payload_kind: &str, role: Option<&str>) -> bool {
    match kind {
        "response_item" => match payload_kind {
            "message" => matches!(role, Some("user" | "assistant")),
            "function_call" | "custom_tool_call" | "local_shell_call" => true,
            _ => false,
        },
        "event_msg" => matches!(
            payload_kind,
            "task_started" | "task_complete" | "turn_aborted" | "token_count"
        ),
        _ => false,
    }
}

/// Agent writers emit compact JSON with the record discriminator before the large payload. That
/// lets the common path reject telemetry without walking megabytes of escaped tool output. The
/// borrowed serde envelope below remains the correctness fallback for whitespace or field order
/// variants, so this shortcut never decides from a discriminator nested inside the payload.
pub(crate) fn compact_record_relevance(source: TranscriptSource, line: &str) -> Option<bool> {
    let kind_at = line.find("\"type\":\"")?;
    match source {
        TranscriptSource::Codex => {
            let payload_at = line.find("\"payload\":")?;
            if kind_at > payload_at {
                return None;
            }
            let after_kind = &line[kind_at + "\"type\":\"".len()..];
            let kind = after_kind.split_once('"')?.0;
            if kind.contains('\\') {
                return None;
            }
            if !matches!(kind, "response_item" | "event_msg") {
                return Some(false);
            }
            let payload = &line[payload_at..];
            let payload_kind_at = payload.find("\"type\":\"")?;
            let nested_at = [
                "\"content\":",
                "\"arguments\":",
                "\"input\":",
                "\"info\":",
                "\"message\":",
                "\"last_agent_message\":",
            ]
            .into_iter()
            .filter_map(|marker| payload.find(marker))
            .min()
            .unwrap_or(payload.len());
            if payload_kind_at > nested_at {
                return None;
            }
            let payload_kind = &payload[payload_kind_at + "\"type\":\"".len()..];
            let payload_kind = payload_kind.split_once('"')?.0;
            if payload_kind.contains('\\') {
                return None;
            }
            if kind == "response_item" && payload_kind == "message" {
                if payload.contains("\"role\":\"user\"")
                    || payload.contains("\"role\":\"assistant\"")
                {
                    return Some(true);
                }
                return None;
            }
            Some(codex_record_relevant(kind, payload_kind, None))
        }
        TranscriptSource::Claude => {
            let content_at = line
                .find("\"message\":")
                .into_iter()
                .chain(line.find("\"data\":"))
                .min()
                .unwrap_or(line.len());
            if kind_at > content_at {
                return None;
            }
            let after_kind = &line[kind_at + "\"type\":\"".len()..];
            let kind = after_kind.split_once('"')?.0;
            if kind.contains('\\') {
                return None;
            }
            Some(matches!(kind, "user" | "assistant"))
        }
        TranscriptSource::Antigravity => {
            let content_at = ["\"content\":", "\"thinking\":", "\"tool_calls\":"]
                .into_iter()
                .filter_map(|marker| line.find(marker))
                .min()
                .unwrap_or(line.len());
            if kind_at > content_at {
                return None;
            }
            let after_kind = &line[kind_at + "\"type\":\"".len()..];
            let kind = after_kind.split_once('"')?.0;
            if kind.contains('\\') {
                return None;
            }
            Some(matches!(kind, "USER_INPUT" | "PLANNER_RESPONSE"))
        }
    }
}

#[derive(Deserialize)]
struct CodexSessionEnvelope<'a> {
    #[serde(borrow)]
    timestamp: Option<Cow<'a, str>>,
    #[serde(borrow)]
    payload: Option<CodexSessionPayload<'a>>,
}

#[derive(Deserialize)]
struct CodexSessionPayload<'a> {
    #[serde(borrow)]
    cwd: Option<Cow<'a, str>>,
    #[serde(borrow)]
    thread_source: Option<Cow<'a, str>>,
}

pub(crate) struct CodexSessionHeader<'a> {
    pub(crate) cwd: Cow<'a, str>,
    pub(crate) is_user_thread: bool,
    pub(crate) timestamp: Option<Cow<'a, str>>,
}

pub(crate) fn codex_session_header(line: &str) -> Option<CodexSessionHeader<'_>> {
    let record = serde_json::from_str::<CodexSessionEnvelope<'_>>(line).ok()?;
    let payload = record.payload?;
    Some(CodexSessionHeader {
        cwd: payload.cwd.unwrap_or_default(),
        is_user_thread: payload.thread_source.as_deref() == Some("user"),
        timestamp: record.timestamp,
    })
}

/// Reads the fields Codex writes before its potentially huge `base_instructions` value. The
/// prefix need not be complete JSON; each extracted string is still decoded by serde_json. A
/// missing field returns `None` so discovery can fall back to the complete-line parser.
pub(crate) fn codex_session_header_prefix(prefix: &str) -> Option<CodexSessionHeader<'static>> {
    let cwd = compact_string_field(prefix, "cwd")?;
    let thread_source = compact_string_field(prefix, "thread_source")?;
    let timestamp = compact_string_field(prefix, "timestamp").map(Cow::Owned);
    Some(CodexSessionHeader {
        cwd: Cow::Owned(cwd),
        is_user_thread: thread_source == "user",
        timestamp,
    })
}

fn compact_string_field(input: &str, key: &str) -> Option<String> {
    let marker = format!("\"{key}\":");
    let value = input.get(input.find(&marker)? + marker.len()..)?;
    if !value.starts_with('"') {
        return None;
    }
    let bytes = value.as_bytes();
    let mut escaped = false;
    for index in 1..bytes.len() {
        match (bytes[index], escaped) {
            (b'"', false) => return serde_json::from_str(&value[..=index]).ok(),
            (b'\\', false) => escaped = true,
            _ => escaped = false,
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_passes_conversation_messages_tool_calls_and_turn_events() {
        assert!(is_relevant(
            TranscriptSource::Codex,
            r#"{"payload":{"content":[],"role":"assistant","type":"message"},"type":"response_item"}"#,
        ));
        assert!(is_relevant(
            TranscriptSource::Codex,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[]}}"#,
        ));
        assert!(!is_relevant(
            TranscriptSource::Codex,
            r#"{"type":"response_item","payload":{"type":"message","role":"developer","content":[]}}"#,
        ));
        assert!(!is_relevant(
            TranscriptSource::Codex,
            r#"{"type":"event_msg","payload":{"type":"agent_reasoning","message":"large ignored payload"}}"#,
        ));
        for line in [
            r#"{"timestamp":"t","type":"response_item","payload":{"type":"function_call","id":"fc","name":"spawn_agent","arguments":"{}"}}"#,
            r#"{"timestamp":"t","type":"response_item","payload":{"type":"custom_tool_call","id":"c","status":"completed","call_id":"x","name":"exec","input":"ls"}}"#,
            r#"{"timestamp":"t","type":"response_item","payload":{"type":"local_shell_call","call_id":"x","action":{}}}"#,
            r#"{"timestamp":"t","type":"event_msg","payload":{"type":"task_started","turn_id":"1"}}"#,
            r#"{"timestamp":"t","type":"event_msg","payload":{"type":"task_complete","turn_id":"1","last_agent_message":"done"}}"#,
            r#"{"timestamp":"t","type":"event_msg","payload":{"type":"turn_aborted","turn_id":"1","reason":"interrupted"}}"#,
            r#"{"timestamp":"t","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{}}}}"#,
        ] {
            assert!(is_relevant(TranscriptSource::Codex, line), "{line}");
        }
        for line in [
            r#"{"timestamp":"t","type":"response_item","payload":{"type":"function_call_output","call_id":"x","output":"huge"}}"#,
            r#"{"timestamp":"t","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"x","output":[{"type":"input_text","text":"huge"}]}}"#,
            r#"{"timestamp":"t","type":"response_item","payload":{"type":"reasoning","summary":[]}}"#,
            r#"{"timestamp":"t","type":"event_msg","payload":{"type":"agent_message","message":"commentary"}}"#,
            r#"{"timestamp":"t","type":"event_msg","payload":{"type":"user_message","message":"typed"}}"#,
            r#"{"timestamp":"t","type":"turn_context","payload":{"type":"task_complete"}}"#,
        ] {
            assert!(!is_relevant(TranscriptSource::Codex, line), "{line}");
        }
    }

    #[test]
    fn claude_only_passes_user_and_assistant_records() {
        assert!(is_relevant(
            TranscriptSource::Claude,
            r#"{"message":{"content":"hello"},"type":"user"}"#,
        ));
        assert!(is_relevant(
            TranscriptSource::Claude,
            r#"{"type":"assistant","message":{"content":[]}}"#,
        ));
        assert!(!is_relevant(
            TranscriptSource::Claude,
            r#"{"type":"progress","data":{"type":"hook_progress"}}"#,
        ));
        assert!(!is_relevant(TranscriptSource::Claude, "not json"));
    }

    #[test]
    fn antigravity_only_passes_the_two_conversation_kinds() {
        assert!(is_relevant(
            TranscriptSource::Antigravity,
            r#"{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","created_at":"t","content":"<USER_REQUEST>x</USER_REQUEST>"}"#,
        ));
        assert!(is_relevant(
            TranscriptSource::Antigravity,
            r#"{"step_index":3,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"t","content":"","tool_calls":[{"name":"view_file","args":{"toolAction":"\"type\":\"VIEW_FILE\""}}]}"#,
        ));
        for line in [
            r#"{"step_index":1,"source":"SYSTEM","type":"EPHEMERAL_MESSAGE","status":"DONE","created_at":"t","content":"reminder"}"#,
            r#"{"step_index":2,"source":"MODEL","type":"VIEW_FILE","status":"DONE","created_at":"t","content":"file body"}"#,
            r#"{"content":"body","type":"CHECKPOINT"}"#,
            r#"{"content":"body first","type":"PLANNER_RESPONSE_X"}"#,
        ] {
            assert!(!is_relevant(TranscriptSource::Antigravity, line), "{line}");
        }
        // Discriminator after the content still classifies through the full envelope.
        assert!(is_relevant(
            TranscriptSource::Antigravity,
            r#"{"content":"late","type":"USER_INPUT"}"#,
        ));
    }

    #[test]
    fn escaped_discriminator_values_are_still_classified() {
        assert!(is_relevant(
            TranscriptSource::Codex,
            r#"{"type":"response_\u0069tem","payload":{"type":"mess\u0061ge","role":"assist\u0061nt"}}"#,
        ));
        assert!(is_relevant(
            TranscriptSource::Claude,
            r#"{"type":"ass\u0069stant"}"#,
        ));
        assert!(is_relevant(
            TranscriptSource::Codex,
            r#"{"type":"event_msg","payload":{"type":"task_compl\u0065te"}}"#,
        ));
    }

    #[test]
    fn reordered_nested_types_fall_back_without_changing_the_answer() {
        assert!(!is_relevant(
            TranscriptSource::Codex,
            r#"{"payload":{"type":"message","role":"assistant"},"type":"event_msg"}"#,
        ));
        assert!(is_relevant(
            TranscriptSource::Claude,
            r#"{"message":{"content":[{"type":"text","text":"hello"}]},"type":"assistant"}"#,
        ));
        assert!(is_relevant(
            TranscriptSource::Codex,
            r#"{"type":"response_item","payload":{"type" : "message","role":"assistant","content":[]}}"#,
        ));
        assert!(is_relevant(
            TranscriptSource::Codex,
            r#"{"type":"response_item","payload":{"arguments":"{\"type\":\"message\"}","type":"function_call","name":"x"}}"#,
        ));
    }

    #[test]
    fn codex_session_header_borrows_only_discovery_fields() {
        let line = r#"{"timestamp":"2026-08-31T10:00:00Z","type":"session_meta","payload":{"base_instructions":{"text":"a large field that discovery does not retain"},"thread_source":"user","cwd":"C:\\work\\app"}}"#;
        let header = codex_session_header(line).unwrap();
        assert_eq!(header.cwd, r"C:\work\app");
        assert!(header.is_user_thread);
        assert_eq!(header.timestamp.as_deref(), Some("2026-08-31T10:00:00Z"));

        assert!(
            !codex_session_header(
                r#"{"payload":{"cwd":"C:/work/app","thread_source":"subagent"}}"#
            )
            .unwrap()
            .is_user_thread
        );
    }

    #[test]
    fn incomplete_session_meta_prefix_avoids_the_large_tail() {
        let prefix = r#"{"timestamp":"2026-08-31T10:00:00Z","type":"session_meta","payload":{"cwd":"C:\\work\\app","thread_source":"user","base_instructions":{"text":"unfinished"#;
        let header = codex_session_header_prefix(prefix).unwrap();
        assert_eq!(header.cwd, r"C:\work\app");
        assert!(header.is_user_thread);
        assert_eq!(header.timestamp.as_deref(), Some("2026-08-31T10:00:00Z"));

        assert!(codex_session_header_prefix(r#"{"payload":{"cwd":"C:/work/app""#).is_none());
    }
}
