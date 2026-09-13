use crate::agent_transcript::{collect_line, Collected, TranscriptSource, MAX_TRANSCRIPT_ENTRIES};
use crate::transcript_activity::ActivityState;
use std::path::Path;

fn collect(lines: &[&str]) -> Collected {
    let mut collected = Collected::new();
    for line in lines {
        collect_line(
            TranscriptSource::Claude,
            line,
            &mut collected,
            MAX_TRANSCRIPT_ENTRIES,
        );
    }
    collected
}

fn user(at: &str, content: serde_json::Value) -> String {
    serde_json::json!({
        "type": "user", "timestamp": at, "isSidechain": false,
        "message": {"role": "user", "content": content}
    })
    .to_string()
}

fn assistant(at: &str, stop_reason: &str, block: serde_json::Value) -> String {
    serde_json::json!({
        "type": "assistant", "timestamp": at, "isSidechain": false,
        "message": {
            "id": "msg", "role": "assistant", "stop_reason": stop_reason,
            "content": [block],
            "usage": {"input_tokens": 2, "output_tokens": 10, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 50}
        }
    })
    .to_string()
}

fn tool_use(id: &str, name: &str, input: serde_json::Value) -> serde_json::Value {
    serde_json::json!({"type": "tool_use", "id": id, "name": name, "input": input})
}

fn tool_result(id: &str, content: &str) -> serde_json::Value {
    serde_json::json!([{"type": "tool_result", "tool_use_id": id, "content": content}])
}

fn full_turn() -> Vec<String> {
    vec![
        user("2026-08-31T10:00:00Z", serde_json::json!("Which layout?")),
        assistant(
            "2026-08-31T10:00:01Z",
            "tool_use",
            serde_json::json!({"type": "text", "text": "Let me look."}),
        ),
        assistant(
            "2026-08-31T10:00:02Z",
            "tool_use",
            tool_use("toolu_1", "Read", serde_json::json!({"file_path": "a.rs"})),
        ),
        user(
            "2026-08-31T10:00:03Z",
            tool_result("toolu_1", "fn main() {}"),
        ),
        assistant(
            "2026-08-31T10:00:04Z",
            "tool_use",
            tool_use(
                "toolu_2",
                "AskUserQuestion",
                serde_json::json!({"questions": [
                    {"question": "Ship it?", "header": "Ship", "multiSelect": false,
                     "options": [{"label": "Yes", "description": "now"}, {"label": "No", "description": "later"}]},
                    {"question": "Where?", "options": [{"label": "Here"}, {"label": "There"}]}
                ]}),
            ),
        ),
        user(
            "2026-08-31T10:00:30Z",
            tool_result(
                "toolu_2",
                r#"Your questions have been answered: "Ship it?"="No", "Where?"="Here". You can now continue."#,
            ),
        ),
        assistant(
            "2026-08-31T10:00:31Z",
            "tool_use",
            tool_use(
                "toolu_3",
                "Edit",
                serde_json::json!({"file_path": "b.rs", "old_string": "a", "new_string": "b"}),
            ),
        ),
        user("2026-08-31T10:00:32Z", tool_result("toolu_3", "ok")),
        assistant(
            "2026-08-31T10:00:40Z",
            "end_turn",
            serde_json::json!({"type": "text", "text": "Shipped."}),
        ),
    ]
}

#[test]
fn a_turn_keeps_its_tools_decisions_and_edited_files() {
    let lines = full_turn();
    let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
    let transcript = collect(&refs).finish("claude", Path::new("s.jsonl"));

    assert_eq!(transcript.total_entries, 2);
    assert_eq!(transcript.entries[0].role, "user");
    assert_eq!(transcript.entries[0].text, "Which layout?");
    assert!(transcript.entries[0].tools.is_empty());

    let reply = &transcript.entries[1];
    assert_eq!(reply.role, "assistant");
    assert_eq!(reply.text, "Let me look.\n\nShipped.");
    assert_eq!(reply.tools, vec!["Read", "AskUserQuestion", "Edit"]);
    assert_eq!(reply.decisions.len(), 2);
    assert_eq!(reply.decisions[0].question, "Ship it?");
    assert_eq!(reply.decisions[0].options, vec!["Yes", "No"]);
    assert_eq!(reply.decisions[0].selected.as_deref(), Some("No"));
    assert_eq!(reply.decisions[1].selected.as_deref(), Some("Here"));
    assert_eq!(reply.at.as_deref(), Some("2026-08-31T10:00:40Z"));
    assert_eq!(transcript.changed_files, vec!["b.rs"]);

    let json = serde_json::to_value(&reply.decisions[0]).unwrap();
    assert_eq!(
        json,
        serde_json::json!({"question": "Ship it?", "options": ["Yes", "No"], "selected": "No"})
    );
}

#[test]
fn activity_walks_prompt_thinking_working_needs_input_and_done() {
    let lines = full_turn();
    let expected = [
        (ActivityState::Thinking, None),
        (ActivityState::Thinking, None),
        (ActivityState::Working, Some("Read")),
        (ActivityState::Working, Some("Read")),
        (ActivityState::NeedsInput, Some("AskUserQuestion")),
        (ActivityState::Working, Some("AskUserQuestion")),
        (ActivityState::Working, Some("Edit")),
        (ActivityState::Working, Some("Edit")),
        (ActivityState::Done, Some("Edit")),
    ];
    let mut collected = Collected::new();
    assert_eq!(collected.activity().state, ActivityState::Idle);
    for (line, (state, tool)) in lines.iter().zip(expected) {
        collect_line(
            TranscriptSource::Claude,
            line,
            &mut collected,
            MAX_TRANSCRIPT_ENTRIES,
        );
        let activity = collected.activity();
        assert_eq!(activity.state, state, "after {line}");
        assert_eq!(activity.last_tool.as_deref(), tool, "after {line}");
    }
    assert_eq!(
        collected.activity().at.as_deref(),
        Some("2026-08-31T10:00:40Z")
    );
}

#[test]
fn usage_sums_every_reply_including_tool_only_ones() {
    let lines = full_turn();
    let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
    let usage = collect(&refs)
        .finish("claude", Path::new("s.jsonl"))
        .usage
        .expect("claude records carry usage");
    assert_eq!(usage.messages, 5);
    assert_eq!(usage.input_tokens, 10);
    assert_eq!(usage.output_tokens, 50);
    assert_eq!(usage.cache_read_tokens, 500);
    assert_eq!(usage.cache_creation_tokens, 250);

    let no_usage = collect(&[&user("t", serde_json::json!("hi"))]);
    assert!(no_usage
        .finish("claude", Path::new("s.jsonl"))
        .usage
        .is_none());
}

#[test]
fn a_plan_approval_waits_and_an_interrupted_question_is_released_by_the_next_reply() {
    let mut collected = collect(&[
        &user("t0", serde_json::json!("plan it")),
        &assistant(
            "t1",
            "tool_use",
            tool_use(
                "toolu_p",
                "ExitPlanMode",
                serde_json::json!({"plan": "..."}),
            ),
        ),
    ]);
    assert_eq!(collected.activity().state, ActivityState::NeedsInput);
    collect_line(
        TranscriptSource::Claude,
        &user("t2", tool_result("toolu_p", "User has approved your plan.")),
        &mut collected,
        MAX_TRANSCRIPT_ENTRIES,
    );
    assert_eq!(collected.activity().state, ActivityState::Working);

    // The person typed a new prompt instead of answering: the question is forgotten.
    collect_line(
        TranscriptSource::Claude,
        &assistant(
            "t3",
            "tool_use",
            tool_use("toolu_q", "AskUserQuestion", serde_json::json!({})),
        ),
        &mut collected,
        MAX_TRANSCRIPT_ENTRIES,
    );
    assert_eq!(collected.activity().state, ActivityState::NeedsInput);
    collect_line(
        TranscriptSource::Claude,
        &user("t4", serde_json::json!("never mind, do this instead")),
        &mut collected,
        MAX_TRANSCRIPT_ENTRIES,
    );
    let activity = collected.activity();
    assert_eq!(activity.state, ActivityState::Thinking);
    assert_eq!(activity.last_tool, None);
}

#[test]
fn a_local_slash_command_is_hidden_and_leaves_the_state_alone() {
    let mut collected = collect(&[
        &user("t0", serde_json::json!("hello")),
        &assistant(
            "t1",
            "end_turn",
            serde_json::json!({"type": "text", "text": "hi"}),
        ),
    ]);
    assert_eq!(collected.activity().state, ActivityState::Done);
    for line in [
        user(
            "t2",
            serde_json::json!("<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>"),
        ),
        user(
            "t3",
            serde_json::json!("<local-command-stdout>Set model to opus</local-command-stdout>"),
        ),
        serde_json::json!({
            "type": "user", "timestamp": "t4", "isMeta": true,
            "message": {"role": "user", "content": "Continue from a previous session."}
        })
        .to_string(),
    ] {
        collect_line(
            TranscriptSource::Claude,
            &line,
            &mut collected,
            MAX_TRANSCRIPT_ENTRIES,
        );
    }
    let transcript = collected.clone().finish("claude", Path::new("s.jsonl"));
    assert_eq!(transcript.total_entries, 2);
    assert_eq!(collected.activity().state, ActivityState::Done);

    // An image-only prompt has nothing to show but does start a turn.
    collect_line(
        TranscriptSource::Claude,
        &user(
            "t5",
            serde_json::json!([{"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "x"}}]),
        ),
        &mut collected,
        MAX_TRANSCRIPT_ENTRIES,
    );
    assert_eq!(collected.activity().state, ActivityState::Thinking);
    assert_eq!(
        collected
            .finish("claude", Path::new("s.jsonl"))
            .total_entries,
        2
    );
}

#[test]
fn a_turn_that_starts_with_a_tool_opens_the_entry_its_words_complete() {
    let collected = collect(&[
        &user("t0", serde_json::json!("look first")),
        &assistant(
            "t1",
            "tool_use",
            tool_use("toolu_1", "Bash", serde_json::json!({"command": "ls"})),
        ),
        &user("t2", tool_result("toolu_1", "a.rs")),
        &assistant(
            "t3",
            "end_turn",
            serde_json::json!({"type": "text", "text": "One file."}),
        ),
        &user("t4", serde_json::json!("thanks")),
        &assistant(
            "t5",
            "end_turn",
            serde_json::json!({"type": "text", "text": "Sure."}),
        ),
    ]);
    let transcript = collected.finish("claude", Path::new("s.jsonl"));
    assert_eq!(transcript.total_entries, 4);
    assert_eq!(transcript.entries[1].text, "One file.");
    assert_eq!(transcript.entries[1].tools, vec!["Bash"]);
    assert_eq!(transcript.entries[3].text, "Sure.");
    assert!(transcript.entries[3].tools.is_empty());
}

#[test]
fn sidechain_records_never_touch_the_visible_turn_or_its_state() {
    let collected = collect(&[
        &user("t0", serde_json::json!("go")),
        &serde_json::json!({
            "type": "assistant", "timestamp": "t1", "isSidechain": true,
            "message": {"role": "assistant", "stop_reason": "end_turn",
                        "content": [{"type": "text", "text": "subagent answer"}],
                        "usage": {"input_tokens": 1, "output_tokens": 1}}
        })
        .to_string(),
    ]);
    let activity = collected.activity();
    assert_eq!(activity.state, ActivityState::Thinking);
    let transcript = collected.finish("claude", Path::new("s.jsonl"));
    assert_eq!(transcript.total_entries, 1);
    assert!(transcript.usage.is_none());
}
