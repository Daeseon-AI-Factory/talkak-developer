use super::*;
use crate::agent_transcript::claude_project_dir_name;
use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;
use std::path::Path;
use tempfile::TempDir;

fn codex_record(home: &Path, name: &str, cwd: &str, at: &str, text: &str) -> PathBuf {
    let directory = home.join(".codex/sessions/2026/08/31");
    create_dir_all(&directory).unwrap();
    let path = directory.join(format!("rollout-{name}.jsonl"));
    let header = serde_json::json!({
        "timestamp": at,
        "type": "session_meta",
        "payload": {"cwd": cwd, "thread_source": "user"}
    });
    let turn = codex_turn(at, "assistant", text);
    std::fs::write(&path, format!("{header}\n{turn}\n")).unwrap();
    path
}

fn codex_turn(at: &str, role: &str, text: &str) -> serde_json::Value {
    serde_json::json!({
        "timestamp": at,
        "type": "response_item",
        "payload": {"type": "message", "role": role, "content": [{"type": "output_text", "text": text}]}
    })
}

fn claude_record(home: &Path, name: &str, cwd: &str, at: &str, text: &str) -> PathBuf {
    let directory = home
        .join(".claude/projects")
        .join(claude_project_dir_name(cwd));
    create_dir_all(&directory).unwrap();
    let path = directory.join(format!("{name}.jsonl"));
    let system = serde_json::json!({
        "type": "system",
        "timestamp": at,
        "sessionId": name,
        "cwd": cwd,
        "isSidechain": false
    });
    let user = claude_turn(at, "user", "question", None);
    let assistant = claude_turn(at, "assistant", text, Some("message-one"));
    std::fs::write(&path, format!("{system}\n{user}\n{assistant}\n")).unwrap();
    path
}

fn claude_turn(at: &str, role: &str, text: &str, message_id: Option<&str>) -> serde_json::Value {
    let mut message = serde_json::json!({
        "role": role,
        "content": [{"type": "text", "text": text}]
    });
    if let Some(message_id) = message_id {
        message["id"] = serde_json::Value::String(message_id.to_string());
    }
    serde_json::json!({
        "type": role,
        "timestamp": at,
        "isSidechain": false,
        "message": message
    })
}

fn read_codex(
    service: &TranscriptService,
    id: &str,
    project: &str,
    started: &str,
    limit: usize,
) -> AgentTranscript {
    service
        .read(
            id.to_string(),
            None,
            project.to_string(),
            Some(started.to_string()),
            Some("codex".to_string()),
            limit,
        )
        .unwrap()
        .unwrap()
}

fn read_claude(
    service: &TranscriptService,
    id: &str,
    project: &str,
    started: &str,
    limit: usize,
) -> AgentTranscript {
    service
        .read(
            id.to_string(),
            None,
            project.to_string(),
            Some(started.to_string()),
            Some("claude".to_string()),
            limit,
        )
        .unwrap()
        .unwrap()
}

fn parsed_lines(service: &TranscriptService, id: &str) -> usize {
    let session_cache = {
        let cache = service.cache.lock().unwrap();
        Arc::clone(&cache[id])
    };
    let cached = session_cache.lock().unwrap();
    match cached.as_ref().expect("the transcript should be cached") {
        CachedSession::Bound(bound) => bound.parsed_lines,
        CachedSession::Pending(_) => panic!("the transcript should be bound"),
    }
}

#[test]
fn two_same_project_sessions_bind_the_record_nearest_their_own_start() {
    let temp = TempDir::new().unwrap();
    let project = "C:/work/app";
    let first = codex_record(
        temp.path(),
        "first",
        project,
        "2026-08-31T10:00:00Z",
        "first",
    );
    let second = codex_record(
        temp.path(),
        "second",
        project,
        "2026-08-31T11:00:00Z",
        "second",
    );
    let service = TranscriptService::at_home(temp.path().to_path_buf());

    let first_result = read_codex(
        &service,
        "talkak-a",
        project,
        "2026-08-31T10:00:00.500Z",
        200,
    );
    let second_result = read_codex(&service, "talkak-b", project, "2026-08-31T10:59:58Z", 200);

    assert_eq!(PathBuf::from(first_result.path), first);
    assert_eq!(PathBuf::from(second_result.path), second);
    assert_eq!(first_result.entries[0].text, "first");
    assert_eq!(second_result.entries[0].text, "second");
}

#[test]
fn codex_cwd_matching_prefers_canonical_path_identity() {
    let temp = TempDir::new().unwrap();
    let project = temp.path().join("workspace");
    create_dir_all(project.join("child")).unwrap();
    let recorded = project.join("child/..").to_string_lossy().into_owned();
    let expected = codex_record(
        temp.path(),
        "canonical-cwd",
        &recorded,
        "2026-08-31T10:00:00Z",
        "matched",
    );
    let service = TranscriptService::at_home(temp.path().to_path_buf());

    let transcript = read_codex(
        &service,
        "talkak-canonical",
        &project.to_string_lossy(),
        "2026-08-31T10:00:00Z",
        200,
    );
    assert_eq!(PathBuf::from(transcript.path), expected);
}

#[test]
fn claude_sessions_bind_the_record_nearest_their_own_start() {
    let temp = TempDir::new().unwrap();
    let project = "C:/work/app";
    let first = claude_record(
        temp.path(),
        "first",
        project,
        "2026-08-31T10:00:00Z",
        "first",
    );
    let second = claude_record(
        temp.path(),
        "second",
        project,
        "2026-08-31T11:00:00Z",
        "second",
    );
    let service = TranscriptService::at_home(temp.path().to_path_buf());

    let first_result = read_claude(
        &service,
        "talkak-claude-a",
        project,
        "2026-08-31T10:00:00.500Z",
        200,
    );
    let second_result = read_claude(
        &service,
        "talkak-claude-b",
        project,
        "2026-08-31T10:59:58Z",
        200,
    );

    assert_eq!(PathBuf::from(first_result.path), first);
    assert_eq!(PathBuf::from(second_result.path), second);
    assert_eq!(first_result.source, "claude");
    assert_eq!(first_result.entries[1].text, "first");
    assert_eq!(second_result.entries[1].text, "second");
}

#[test]
fn unchanged_hits_cache_and_growth_reads_only_new_complete_lines() {
    let temp = TempDir::new().unwrap();
    let project = "C:/work/app";
    let path = codex_record(temp.path(), "one", project, "2026-08-31T10:00:00Z", "one");
    let service = TranscriptService::at_home(temp.path().to_path_buf());
    let first = read_codex(&service, "talkak-a", project, "2026-08-31T10:00:00Z", 200);
    let parsed_after_first = parsed_lines(&service, "talkak-a");

    let unchanged = read_codex(&service, "talkak-a", project, "2026-08-31T10:00:00Z", 200);
    assert_eq!(unchanged.total_entries, first.total_entries);
    assert_eq!(parsed_lines(&service, "talkak-a"), parsed_after_first);

    let next = codex_turn("2026-08-31T10:01:00Z", "assistant", "two").to_string();
    let split = next.len() / 2;
    let mut file = OpenOptions::new().append(true).open(&path).unwrap();
    file.write_all(&next.as_bytes()[..split]).unwrap();
    file.flush().unwrap();
    let partial = read_codex(&service, "talkak-a", project, "2026-08-31T10:00:00Z", 200);
    assert_eq!(partial.total_entries, 1);

    file.write_all(&next.as_bytes()[split..]).unwrap();
    file.write_all(b"\n").unwrap();
    file.flush().unwrap();
    let complete = read_codex(&service, "talkak-a", project, "2026-08-31T10:00:00Z", 200);
    assert_eq!(complete.total_entries, 2);
    assert_eq!(complete.entries[1].text, "two");
    assert_eq!(parsed_lines(&service, "talkak-a"), parsed_after_first + 1);
}

#[test]
fn claude_cache_reads_only_complete_appends_and_merges_the_human_turn() {
    let temp = TempDir::new().unwrap();
    let project = "C:/work/app";
    let path = claude_record(
        temp.path(),
        "one",
        project,
        "2026-08-31T10:00:00Z",
        "first part",
    );
    let service = TranscriptService::at_home(temp.path().to_path_buf());
    let first = read_claude(
        &service,
        "talkak-claude-a",
        project,
        "2026-08-31T10:00:00Z",
        200,
    );
    assert_eq!(first.total_entries, 2);
    let parsed_after_first = parsed_lines(&service, "talkak-claude-a");

    let unchanged = read_claude(
        &service,
        "talkak-claude-a",
        project,
        "2026-08-31T10:00:00Z",
        200,
    );
    assert_eq!(unchanged.total_entries, first.total_entries);
    assert_eq!(
        parsed_lines(&service, "talkak-claude-a"),
        parsed_after_first
    );

    // Claude changes message ids around tool calls, but TALKAK presents the assistant side of the
    // same human prompt as one readable turn.
    let next = claude_turn(
        "2026-08-31T10:01:00Z",
        "assistant",
        "second part",
        Some("message-two"),
    )
    .to_string();
    let split = next.len() / 2;
    let mut file = OpenOptions::new().append(true).open(&path).unwrap();
    let tool_result = serde_json::json!({
        "type": "user",
        "isMeta": true,
        "timestamp": "2026-08-31T10:00:30Z",
        "message": {
            "role": "user",
            "content": [{"type": "tool_result", "tool_use_id": "tool-one", "content": "ok"}]
        }
    });
    writeln!(file, "{tool_result}").unwrap();
    let sidechain_prompt = serde_json::json!({
        "type": "user",
        "isSidechain": true,
        "message": {"role": "user", "content": [{"type": "text", "text": "subagent"}]}
    });
    writeln!(file, "{sidechain_prompt}").unwrap();
    file.write_all(&next.as_bytes()[..split]).unwrap();
    file.flush().unwrap();
    let partial = read_claude(
        &service,
        "talkak-claude-a",
        project,
        "2026-08-31T10:00:00Z",
        200,
    );
    assert_eq!(partial.entries[1].text, "first part");

    file.write_all(&next.as_bytes()[split..]).unwrap();
    file.write_all(b"\n").unwrap();
    file.flush().unwrap();
    let complete = read_claude(
        &service,
        "talkak-claude-a",
        project,
        "2026-08-31T10:00:00Z",
        200,
    );
    assert_eq!(complete.total_entries, 2);
    assert_eq!(complete.entries[1].text, "first part\n\nsecond part");
    assert_eq!(
        complete.entries[1].at.as_deref(),
        Some("2026-08-31T10:01:00Z")
    );
    assert_eq!(
        complete.last_activity.as_deref(),
        Some("2026-08-31T10:01:00Z")
    );
    assert_eq!(
        parsed_lines(&service, "talkak-claude-a"),
        parsed_after_first + 3
    );

    let tool_only = serde_json::json!({
        "type": "assistant",
        "timestamp": "2026-08-31T10:01:15Z",
        "message": {
            "id": "message-tool",
            "role": "assistant",
            "content": [{"type": "tool_use", "name": "Read", "input": {"file_path": "a.rs"}}]
        }
    });
    writeln!(file, "{tool_only}").unwrap();
    file.flush().unwrap();
    let after_tool = read_claude(
        &service,
        "talkak-claude-a",
        project,
        "2026-08-31T10:00:00Z",
        200,
    );
    assert_eq!(after_tool.entries[1].text, "first part\n\nsecond part");
    assert_eq!(
        after_tool.entries[1].at.as_deref(),
        Some("2026-08-31T10:01:15Z")
    );
    assert_eq!(
        after_tool.last_activity.as_deref(),
        Some("2026-08-31T10:01:15Z")
    );
    assert_eq!(
        parsed_lines(&service, "talkak-claude-a"),
        parsed_after_first + 4
    );

    // Claude's array-text Continue descriptor is meta: hide it, but keep its real prompt boundary.
    let continue_prompt = serde_json::json!({
        "type": "user",
        "isMeta": true,
        "timestamp": "2026-08-31T10:01:30Z",
        "message": {
            "role": "user",
            "content": [{"type": "text", "text": "Continue from a previous session."}]
        }
    });
    writeln!(file, "{continue_prompt}").unwrap();
    writeln!(
        file,
        "{}",
        claude_turn(
            "2026-08-31T10:01:31Z",
            "assistant",
            "after continue",
            Some("message-three"),
        )
    )
    .unwrap();
    file.flush().unwrap();
    let after_continue = read_claude(
        &service,
        "talkak-claude-a",
        project,
        "2026-08-31T10:00:00Z",
        200,
    );
    assert_eq!(after_continue.total_entries, 3);
    assert_eq!(after_continue.entries[2].text, "after continue");

    // An image-only human prompt has no visible text, but still ends the previous assistant turn.
    let image_prompt = serde_json::json!({
        "type": "user",
        "timestamp": "2026-08-31T10:02:00Z",
        "message": {"role": "user", "content": [{
            "type": "image",
            "source": {"type": "base64", "media_type": "image/png", "data": "x"}
        }]}
    });
    writeln!(file, "{image_prompt}").unwrap();
    writeln!(
        file,
        "{}",
        claude_turn(
            "2026-08-31T10:02:01Z",
            "assistant",
            "after image",
            Some("message-four"),
        )
    )
    .unwrap();
    file.flush().unwrap();
    let after_image = read_claude(
        &service,
        "talkak-claude-a",
        project,
        "2026-08-31T10:00:00Z",
        200,
    );
    assert_eq!(after_image.total_entries, 4);
    assert_eq!(after_image.entries[3].text, "after image");
}

#[test]
fn truncation_resets_the_projection_instead_of_mixing_two_files() {
    let temp = TempDir::new().unwrap();
    let project = "C:/work/app";
    let path = codex_record(
        temp.path(),
        "one",
        project,
        "2026-08-31T10:00:00Z",
        "old text that is deliberately longer",
    );
    let service = TranscriptService::at_home(temp.path().to_path_buf());
    let original = read_codex(&service, "talkak-a", project, "2026-08-31T10:00:00Z", 200);
    assert_eq!(original.total_entries, 1);

    let header = serde_json::json!({
        "timestamp": "2026-08-31T10:00:00Z",
        "type": "session_meta",
        "payload": {"cwd": project, "thread_source": "user"}
    });
    let turn = codex_turn("2026-08-31T10:02:00Z", "assistant", "new");
    std::fs::write(&path, format!("{header}\n{turn}\n")).unwrap();
    let reset = read_codex(&service, "talkak-a", project, "2026-08-31T10:00:00Z", 200);
    assert_eq!(reset.total_entries, 1);
    assert_eq!(reset.entries[0].text, "new");
}
