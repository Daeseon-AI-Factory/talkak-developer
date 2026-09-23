use super::*;
use crate::transcript_activity::ActivityState;
use crate::transcript_antigravity::antigravity_root;
use crate::transcript_paths::claude_project_dir_name;
use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering};
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
    std::fs::write(&path, format!("{header}\n{}\n", codex_turn(at, text))).unwrap();
    path
}

fn codex_turn(at: &str, text: &str) -> serde_json::Value {
    serde_json::json!({
        "timestamp": at,
        "type": "response_item",
        "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": text}]}
    })
}

fn antigravity_record(home: &Path, id: &str, at: &str, text: &str) -> PathBuf {
    let directory = antigravity_root(home)
        .join(id)
        .join(".system_generated/logs");
    create_dir_all(&directory).unwrap();
    let path = directory.join("transcript.jsonl");
    let prompt = serde_json::json!({
        "step_index": 0, "source": "USER_EXPLICIT", "type": "USER_INPUT", "status": "DONE",
        "created_at": at, "content": format!("<USER_REQUEST>\n{text}\n</USER_REQUEST>")
    });
    let reply = serde_json::json!({
        "step_index": 1, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE",
        "created_at": at, "content": format!("answer to {text}"), "tool_calls": []
    });
    std::fs::write(&path, format!("{prompt}\n{reply}\n")).unwrap();
    path
}

fn scope(id: &str, project: &str, started: &str, command: &str) -> TranscriptScope {
    TranscriptScope {
        session_id: id.into(),
        run_id: None,
        project_path: project.into(),
        started_at: Some(started.into()),
        agent_command: Some(command.into()),
    }
}

#[test]
fn a_known_revision_short_circuits_until_the_projection_actually_changes() {
    let temp = TempDir::new().unwrap();
    let project = "C:/work/app";
    let path = codex_record(temp.path(), "one", project, "2026-08-31T10:00:00Z", "one");
    let service = TranscriptService::at_home(temp.path().to_path_buf());
    let scope = scope("talkak-a", project, "2026-08-31T10:00:00Z", "codex");

    let first = service.read_changed(scope.clone(), None, 200).unwrap();
    let TranscriptRead::Transcript { transcript } = &first else {
        panic!("a cold read returns the transcript")
    };
    assert!(transcript.revision > 0);
    assert_eq!(transcript.binding, "exact");
    let revision = transcript.revision;

    let unchanged = service
        .read_changed(scope.clone(), Some(revision), 200)
        .unwrap();
    assert!(matches!(unchanged, TranscriptRead::Unchanged { revision: r } if r == revision));
    assert!(matches!(
        service
            .read_changed(scope.clone(), Some(revision + 1), 200)
            .unwrap(),
        TranscriptRead::Transcript { .. }
    ));

    // Appended telemetry the projection ignores does not move the revision.
    let mut file = OpenOptions::new().append(true).open(&path).unwrap();
    writeln!(
        file,
        r#"{{"timestamp":"t","type":"event_msg","payload":{{"type":"agent_reasoning","message":"ignored"}}}}"#
    )
    .unwrap();
    file.flush().unwrap();
    assert!(matches!(
        service
            .read_changed(scope.clone(), Some(revision), 200)
            .unwrap(),
        TranscriptRead::Unchanged { .. }
    ));

    writeln!(file, "{}", codex_turn("2026-08-31T10:01:00Z", "two")).unwrap();
    file.flush().unwrap();
    let changed = service
        .read_changed(scope.clone(), Some(revision), 200)
        .unwrap();
    let TranscriptRead::Transcript { transcript } = &changed else {
        panic!("an appended turn returns the transcript")
    };
    assert_ne!(transcript.revision, revision);
    assert_eq!(transcript.entries[1].text, "two");

    let activity = service.activity(scope.clone()).unwrap().unwrap();
    assert_eq!(activity.revision, transcript.revision);
    assert_eq!(activity.activity.state, ActivityState::Thinking);
    assert_eq!(
        serde_json::to_value(&activity).unwrap()["activity"]["state"],
        "thinking"
    );

    let json = serde_json::to_value(&changed).unwrap();
    assert_eq!(json["kind"], "transcript");
    assert_eq!(
        serde_json::to_value(TranscriptRead::Unchanged { revision: 7 }).unwrap(),
        serde_json::json!({"kind": "unchanged", "revision": 7})
    );
    assert_eq!(
        serde_json::to_value(TranscriptRead::Absent).unwrap(),
        serde_json::json!({"kind": "absent"})
    );
    assert!(service
        .activity(scope_for_missing(&scope))
        .unwrap()
        .is_none());
}

fn scope_for_missing(scope: &TranscriptScope) -> TranscriptScope {
    TranscriptScope {
        session_id: "talkak-missing".into(),
        project_path: "C:/work/elsewhere".into(),
        ..scope.clone()
    }
}

#[test]
fn a_discovery_miss_is_remembered_until_a_watched_directory_changes() {
    let temp = TempDir::new().unwrap();
    let project = "C:/work/app";
    let entered = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&entered);
    let service = TranscriptService::at_home_with_hook(
        temp.path().to_path_buf(),
        Arc::new(move |_| {
            counter.fetch_add(1, Ordering::SeqCst);
        }),
    );
    let scope = scope("talkak-shell", project, "2026-08-31T10:00:00Z", "claude");

    assert!(matches!(
        service.read_changed(scope.clone(), None, 200).unwrap(),
        TranscriptRead::Absent
    ));
    assert_eq!(entered.load(Ordering::SeqCst), 1);
    for _ in 0..3 {
        assert!(matches!(
            service.read_changed(scope.clone(), None, 200).unwrap(),
            TranscriptRead::Absent
        ));
    }
    assert!(service.activity(scope.clone()).unwrap().is_none());
    assert_eq!(
        entered.load(Ordering::SeqCst),
        1,
        "a miss within the recheck window must not re-enter discovery"
    );

    // A different run is a different question.
    let mut rerun = scope.clone();
    rerun.run_id = Some(2);
    assert!(matches!(
        service.read_changed(rerun, None, 200).unwrap(),
        TranscriptRead::Absent
    ));
    assert_eq!(entered.load(Ordering::SeqCst), 2);

    // The record appears: the project directory's mtime moves and discovery runs again.
    let directory = temp
        .path()
        .join(".claude/projects")
        .join(claude_project_dir_name(project));
    create_dir_all(&directory).unwrap();
    let user = serde_json::json!({
        "type": "user", "timestamp": "2026-08-31T10:00:05Z",
        "message": {"role": "user", "content": "question"}
    });
    std::fs::write(directory.join("session.jsonl"), format!("{user}\n")).unwrap();
    let TranscriptRead::Transcript { transcript } =
        service.read_changed(scope.clone(), None, 200).unwrap()
    else {
        panic!("the new record binds")
    };
    assert_eq!(transcript.entries[0].text, "question");
    assert_eq!(entered.load(Ordering::SeqCst), 3);
    assert!(matches!(
        service.read_changed(scope, None, 200).unwrap(),
        TranscriptRead::Transcript { .. }
    ));
    assert_eq!(entered.load(Ordering::SeqCst), 3);
}

#[test]
fn an_antigravity_launch_binds_the_session_started_nearest_its_own_start() {
    let temp = TempDir::new().unwrap();
    let project = "C:/work/app";
    let first = antigravity_record(temp.path(), "aaaa", "2026-08-31T10:00:00Z", "first");
    let second = antigravity_record(temp.path(), "bbbb", "2026-08-31T11:00:00Z", "second");
    let service = TranscriptService::at_home(temp.path().to_path_buf());

    let TranscriptRead::Transcript { transcript } = service
        .read_changed(
            scope("talkak-a", project, "2026-08-31T10:00:00.500Z", "agy"),
            None,
            200,
        )
        .unwrap()
    else {
        panic!("the first agy session binds")
    };
    assert_eq!(PathBuf::from(&transcript.path), first);
    assert_eq!(transcript.source, "antigravity");
    assert_eq!(transcript.entries[0].text, "first");
    assert_eq!(transcript.entries[1].text, "answer to first");
    assert_eq!(transcript.activity.state, ActivityState::Done);
    assert!(transcript.usage.is_none());

    let TranscriptRead::Transcript { transcript } = service
        .read_changed(
            scope(
                "talkak-b",
                project,
                "2026-08-31T10:59:58Z",
                r"C:\Users\me\AppData\Roaming\npm\antigravity.cmd",
            ),
            None,
            200,
        )
        .unwrap()
    else {
        panic!("the second agy session binds")
    };
    assert_eq!(PathBuf::from(&transcript.path), second);

    // Launched before either session existed: nothing binds, and the miss is cached.
    assert!(matches!(
        service
            .read_changed(
                scope("talkak-c", project, "2026-08-31T12:00:00Z", "agy"),
                None,
                200
            )
            .unwrap(),
        TranscriptRead::Absent
    ));
    assert_eq!(
        provider_hint(Some("/usr/local/bin/agy")),
        Some(TranscriptSource::Antigravity)
    );
}
