use super::*;
use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;
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
