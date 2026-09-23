//! Claude Code record adapter: `~/.claude/projects/<dir>/<id>.jsonl`.
//!
//! Every record is one API content block wrapped in `{type, message, timestamp, ...}`. A human
//! prompt is a `user` record whose content is a string or has no `tool_result` block; a tool result
//! is also typed `user` but stays inside the assistant turn. The assistant's `message.stop_reason`
//! is written once the whole API message streamed, so `end_turn` on any of its records means the
//! answer is complete.

use crate::agent_transcript::{strip_harness_wrapper, Collected, Decision, TranscriptEntry};
use crate::transcript_usage::{usage_field, UsageSample};
use serde_json::Value;

const GROUP: &str = "claude-assistant-turn";
/// Tools whose call is a question to the person rather than work.
const ASKS_PERSON: [&str; 2] = ["AskUserQuestion", "ExitPlanMode"];
const EDIT_TOOLS: [&str; 3] = ["Edit", "Write", "NotebookEdit"];

struct ToolCall {
    call_id: Option<String>,
    name: String,
    decisions: Vec<Decision>,
}

pub(crate) fn collect_claude_value(value: &Value, collected: &mut Collected, limit: usize) {
    // A sidechain is a subagent's separate conversation and never affects the visible turn.
    if value.get("isSidechain").and_then(Value::as_bool) == Some(true) {
        return;
    }
    let role = match value.get("type").and_then(Value::as_str) {
        Some("user") => "user",
        Some("assistant") => "assistant",
        _ => return,
    };
    let message = value.get("message");
    let content = message.and_then(|message| message.get("content"));
    let blocks = content.and_then(Value::as_array);
    let has_tool_result = blocks.is_some_and(|blocks| {
        blocks
            .iter()
            .any(|block| block_kind(block) == Some("tool_result"))
    });
    // TALKAK uses every real user-prompt record as the assistant-turn boundary, even when the
    // prompt is image-only and therefore has no text to render. Tool-result records are also typed
    // as `user`, but remain inside the current turn.
    let is_user_prompt = role == "user"
        && match content {
            Some(Value::String(_)) => true,
            Some(Value::Array(_)) => !has_tool_result,
            _ => false,
        };
    let at = value.get("timestamp").and_then(Value::as_str);

    if role == "user" && has_tool_result {
        for block in blocks.into_iter().flatten() {
            if block_kind(block) != Some("tool_result") {
                continue;
            }
            if let Some(call_id) = block.get("tool_use_id").and_then(Value::as_str) {
                collected.resolve_decisions(call_id, &result_text(block));
                collected.activity_mut().tool_finished(call_id, at);
            }
        }
        return;
    }
    if value.get("isMeta").and_then(Value::as_bool) == Some(true) {
        if is_user_prompt {
            collected.close_group();
        }
        return;
    }
    if role == "assistant" {
        // Tool-only replies carry usage too, so this precedes the empty-text return below.
        if let Some(usage) = message.and_then(|message| message.get("usage")) {
            collected.add_usage(UsageSample {
                input_tokens: usage_field(usage, "input_tokens"),
                output_tokens: usage_field(usage, "output_tokens"),
                cache_read_tokens: usage_field(usage, "cache_read_input_tokens"),
                cache_creation_tokens: usage_field(usage, "cache_creation_input_tokens"),
            });
        }
    }

    let mut text = String::new();
    let mut tools = Vec::new();
    let mut has_image = false;
    match content {
        Some(Value::String(plain)) => text.push_str(plain),
        Some(Value::Array(blocks)) => {
            for block in blocks {
                match block_kind(block) {
                    Some("text") => {
                        if let Some(value) = block.get("text").and_then(Value::as_str) {
                            if !text.is_empty() {
                                text.push_str("\n\n");
                            }
                            text.push_str(value);
                        }
                    }
                    Some("tool_use") => {
                        let name = block.get("name").and_then(Value::as_str).unwrap_or("");
                        if EDIT_TOOLS.contains(&name) {
                            if let Some(file) = block
                                .get("input")
                                .and_then(|input| input.get("file_path"))
                                .and_then(Value::as_str)
                            {
                                collected.touched(file);
                            }
                        }
                        if !name.is_empty() {
                            tools.push(ToolCall {
                                call_id: block
                                    .get("id")
                                    .and_then(Value::as_str)
                                    .map(str::to_string),
                                name: name.to_string(),
                                decisions: if name == "AskUserQuestion" {
                                    question_decisions(block)
                                } else {
                                    Vec::new()
                                },
                            });
                        }
                    }
                    Some("image") => has_image = true,
                    _ => {}
                }
            }
        }
        _ => {}
    }
    let text = strip_harness_wrapper(&text);
    let at_owned = at.map(str::to_string);

    if role == "user" {
        if !is_user_prompt {
            return;
        }
        if text.is_empty() {
            // A local slash command is recorded as a prompt the agent never answers; only an
            // image-only prompt starts a turn without visible text.
            collected.close_group();
            if has_image {
                collected.activity_mut().prompt(at);
            }
            return;
        }
        collected.push_merging(TranscriptEntry::new("user", text, at_owned), None, limit);
        collected.activity_mut().prompt(at);
        return;
    }

    // Claude can emit several API messages while answering one human prompt (for example around
    // tool calls), and those messages have different ids. TALKAK's conversation reader groups the
    // whole assistant side of that human turn; using message.id here split it into needless bubbles.
    // A non-empty human user record clears this group, while tool-result records contain no visible
    // text and deliberately leave it open.
    collected.activity_mut().progress(at);
    if !text.is_empty() {
        collected.push_merging(
            TranscriptEntry::new("assistant", text, at_owned.clone()),
            Some(GROUP.to_string()),
            limit,
        );
    } else if tools.is_empty() {
        // A reasoning-only record still advances its visible assistant turn's timestamp.
        collected.touch_open_group_at(GROUP, at_owned.clone());
    }
    let ended = tools.is_empty()
        && matches!(
            message
                .and_then(|message| message.get("stop_reason"))
                .and_then(Value::as_str),
            Some("end_turn" | "stop_sequence")
        );
    for tool in tools {
        let asks_person = ASKS_PERSON.contains(&tool.name.as_str());
        collected.attach_tool(GROUP, &tool.name, tool.decisions, at_owned.clone(), limit);
        collected
            .activity_mut()
            .tool_started(tool.call_id.as_deref(), &tool.name, asks_person, at);
    }
    if ended {
        collected.activity_mut().turn_done(at);
    }
}

fn block_kind(block: &Value) -> Option<&str> {
    block.get("type").and_then(Value::as_str)
}

/// The text of a tool result, which is a string or a list of text blocks.
fn result_text(block: &Value) -> String {
    match block.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter(|part| block_kind(part) == Some("text"))
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// `input.questions[].question` with `options[].label`, tagged with the call id so the answer
/// record can fill `selected` later.
fn question_decisions(block: &Value) -> Vec<Decision> {
    let call_id = block.get("id").and_then(Value::as_str).map(str::to_string);
    let Some(questions) = block
        .get("input")
        .and_then(|input| input.get("questions"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    questions
        .iter()
        .filter_map(|question| {
            let text = question.get("question")?.as_str()?.to_string();
            let options = question
                .get("options")
                .and_then(Value::as_array)
                .map(|options| {
                    options
                        .iter()
                        .filter_map(|option| option.get("label").and_then(Value::as_str))
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            Some(Decision {
                question: text,
                options,
                selected: None,
                call_id: call_id.clone(),
            })
        })
        .collect()
}

#[cfg(test)]
#[path = "transcript_claude_tests.rs"]
mod tests;
