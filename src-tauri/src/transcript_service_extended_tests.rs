use super::*;
use crate::agent_transcript::MAX_TRANSCRIPT_TURN_CHARS;
use session_broker::store::StoredSession;
use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::{Condvar, Mutex as TestMutex};
use std::thread;
use std::time::Duration;
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

#[test]
fn every_returned_turn_and_the_ui_tail_are_hard_bounded() {
    let temp = TempDir::new().unwrap();
    let project = "C:/work/app";
    let path = codex_record(
        temp.path(),
        "one",
        project,
        "2026-08-31T10:00:00Z",
        &"x".repeat(MAX_TRANSCRIPT_TURN_CHARS + 25),
    );
    let mut file = OpenOptions::new().append(true).open(path).unwrap();
    for index in 0..850 {
        writeln!(
            file,
            "{}",
            codex_turn("2026-08-31T10:01:00Z", "user", &format!("turn {index}"))
        )
        .unwrap();
    }
    let service = TranscriptService::at_home(temp.path().to_path_buf());
    let transcript = service
        .read(
            "talkak-a".into(),
            None,
            project.into(),
            Some("2026-08-31T10:00:00Z".into()),
            Some("codex".into()),
            usize::MAX,
        )
        .unwrap()
        .unwrap();

    assert_eq!(transcript.total_entries, 851);
    assert_eq!(transcript.entries.len(), MAX_TRANSCRIPT_ENTRIES);
    assert!(transcript
        .entries
        .iter()
        .all(|entry| entry.text.chars().count() <= MAX_TRANSCRIPT_TURN_CHARS));
}

#[test]
fn timestamps_with_offsets_compare_as_the_same_instant() {
    assert_eq!(
        parse_rfc3339_ms("2026-08-31T10:15:30.123Z"),
        parse_rfc3339_ms("2026-08-31T06:15:30.123-04:00")
    );
    assert!(parse_rfc3339_ms("14:08").is_none());
}

#[test]
fn windows_command_shims_remain_provider_hints() {
    assert_eq!(
        provider_hint(Some(r"C:\Users\me\AppData\Roaming\npm\codex.CMD")),
        Some(TranscriptSource::Codex)
    );
    assert_eq!(
        provider_hint(Some("/usr/local/bin/claude")),
        Some(TranscriptSource::Claude)
    );
    assert_eq!(provider_hint(Some("pwsh")), None);
}

#[test]
fn a_cold_service_uses_the_brokers_current_run_start_not_the_sessions_first_start() {
    let temp = TempDir::new().unwrap();
    let project = "C:/work/app";
    let first = codex_record(
        temp.path(),
        "first",
        project,
        "2026-08-31T10:00:00Z",
        "first run",
    );
    let second = codex_record(
        temp.path(),
        "second",
        project,
        "2026-08-31T11:00:00Z",
        "second run",
    );
    let store = SessionStore::at(temp.path().join("runtime-sessions"));
    store
        .record(&StoredSession {
            session_id: "talkak-a".into(),
            run_id: Some(2),
            cwd: Some(project.into()),
            command: Some("codex".into()),
            args: Vec::new(),
            cols: 100,
            rows: 30,
            started_at_ms: parse_rfc3339_ms("2026-08-31T11:00:00Z").unwrap() as u64,
        })
        .unwrap();
    let service = TranscriptService::at_home_with_store(temp.path().to_path_buf(), store);

    // Workspace prewarm runs before the first runtime observation, so run_id is intentionally None.
    let transcript = service
        .read(
            "talkak-a".into(),
            None,
            project.into(),
            Some("2026-08-31T10:00:00Z".into()),
            Some("codex".into()),
            MAX_TRANSCRIPT_ENTRIES,
        )
        .unwrap()
        .unwrap();

    assert_ne!(PathBuf::from(&transcript.path), first);
    assert_eq!(PathBuf::from(&transcript.path), second);
    assert_eq!(transcript.entries[0].text, "second run");
}

#[test]
fn delayed_null_and_old_requests_cannot_replace_the_brokers_current_run() {
    let temp = TempDir::new().unwrap();
    let project = "C:/work/app";
    let old_path = codex_record(
        temp.path(),
        "first",
        project,
        "2026-08-31T10:00:00Z",
        "first run",
    );
    let store = SessionStore::at(temp.path().join("runtime-sessions"));
    let definition = |run_id, started_at_ms| StoredSession {
        session_id: "talkak-a".into(),
        run_id: Some(run_id),
        cwd: Some(project.into()),
        command: Some("codex".into()),
        args: Vec::new(),
        cols: 100,
        rows: 30,
        started_at_ms,
    };
    store
        .record(&definition(
            1,
            parse_rfc3339_ms("2026-08-31T10:00:00Z").unwrap() as u64,
        ))
        .unwrap();
    let service = TranscriptService::at_home_with_store(temp.path().to_path_buf(), store);

    // An early Workspace prewarm has no runtime observation yet, but the broker definition binds
    // it to run 1 rather than creating an unversioned cache entry.
    let prewarmed = service
        .read(
            "talkak-a".into(),
            None,
            project.into(),
            Some("2026-08-31T10:00:00Z".into()),
            Some("codex".into()),
            MAX_TRANSCRIPT_ENTRIES,
        )
        .unwrap()
        .unwrap();
    assert_eq!(PathBuf::from(prewarmed.path), old_path);

    let new_path = codex_record(
        temp.path(),
        "second",
        project,
        "2026-08-31T11:00:00Z",
        "second run",
    );
    service
        .store
        .as_deref()
        .unwrap()
        .record(&definition(
            2,
            parse_rfc3339_ms("2026-08-31T11:00:00Z").unwrap() as u64,
        ))
        .unwrap();
    let current = service
        .read(
            "talkak-a".into(),
            Some(2),
            project.into(),
            Some("2026-08-31T11:00:00Z".into()),
            Some("codex".into()),
            MAX_TRANSCRIPT_ENTRIES,
        )
        .unwrap()
        .unwrap();
    assert_eq!(PathBuf::from(current.path), new_path);

    // This response was queued against run 1 and arrives last. The persisted run 2 is
    // authoritative, so it must return and retain run 2 instead of entering a stale rebind.
    let delayed_old = service
        .read(
            "talkak-a".into(),
            Some(1),
            project.into(),
            Some("2026-08-31T10:00:00Z".into()),
            Some("codex".into()),
            MAX_TRANSCRIPT_ENTRIES,
        )
        .unwrap()
        .unwrap();
    assert_eq!(PathBuf::from(delayed_old.path), new_path);
    assert_eq!(delayed_old.entries[0].text, "second run");

    let session_cache = {
        let registry = service.cache.lock().unwrap();
        Arc::clone(&registry["talkak-a"])
    };
    let cache = session_cache.lock().unwrap();
    let Some(CachedSession::Bound(bound)) = cache.as_ref() else {
        panic!("the current run should remain bound")
    };
    assert_eq!(bound.run_id, Some(2));
}

#[test]
fn cold_reads_for_different_sessions_do_not_wait_on_one_global_lock() {
    struct Gate {
        state: TestMutex<(usize, bool)>,
        changed: Condvar,
    }

    let temp = TempDir::new().unwrap();
    let first_project = "C:/work/first";
    let second_project = "C:/work/second";
    codex_record(
        temp.path(),
        "first-project",
        first_project,
        "2026-08-31T10:00:00Z",
        "first",
    );
    codex_record(
        temp.path(),
        "second-project",
        second_project,
        "2026-08-31T10:00:00Z",
        "second",
    );

    let gate = Arc::new(Gate {
        state: TestMutex::new((0, false)),
        changed: Condvar::new(),
    });
    let hook_gate = Arc::clone(&gate);
    let service = Arc::new(TranscriptService::at_home_with_hook(
        temp.path().to_path_buf(),
        Arc::new(move |_| {
            let mut state = hook_gate.state.lock().unwrap();
            state.0 += 1;
            hook_gate.changed.notify_all();
            while !state.1 {
                state = hook_gate.changed.wait(state).unwrap();
            }
        }),
    ));
    let read = |service: Arc<TranscriptService>, id: &str, project: &str| {
        let id = id.to_string();
        let project = project.to_string();
        thread::spawn(move || {
            service.read(
                id,
                None,
                project,
                Some("2026-08-31T10:00:00Z".into()),
                Some("codex".into()),
                MAX_TRANSCRIPT_ENTRIES,
            )
        })
    };
    let first = read(Arc::clone(&service), "talkak-a", first_project);
    let second = read(Arc::clone(&service), "talkak-b", second_project);

    let state = gate.state.lock().unwrap();
    let (mut state, _) = gate
        .changed
        .wait_timeout_while(state, Duration::from_secs(2), |state| state.0 < 2)
        .unwrap();
    let overlapped = state.0 == 2;
    state.1 = true;
    gate.changed.notify_all();
    drop(state);

    assert!(first.join().unwrap().unwrap().is_some());
    assert!(second.join().unwrap().unwrap().is_some());
    assert!(
        overlapped,
        "the second session never entered its cold read while the first was paused"
    );
}

#[test]
fn a_new_run_waits_for_and_then_binds_a_new_record() {
    let temp = TempDir::new().unwrap();
    let project = "C:/work/app";
    let old_path = codex_record(
        temp.path(),
        "first",
        project,
        "2026-08-31T10:00:00Z",
        "first run",
    );
    let service = TranscriptService::at_home(temp.path().to_path_buf());
    let first = service
        .read(
            "talkak-a".into(),
            Some(1),
            project.into(),
            Some("2026-08-31T10:00:00Z".into()),
            Some("codex".into()),
            MAX_TRANSCRIPT_ENTRIES,
        )
        .unwrap()
        .unwrap();
    assert_eq!(PathBuf::from(first.path), old_path);

    let waiting = service
        .read(
            "talkak-a".into(),
            Some(2),
            project.into(),
            Some("2026-08-31T10:00:00Z".into()),
            Some("codex".into()),
            MAX_TRANSCRIPT_ENTRIES,
        )
        .unwrap();
    assert!(waiting.is_none());

    let new_path = codex_record(
        temp.path(),
        "second",
        project,
        "2099-08-31T11:00:00Z",
        "second run",
    );
    let rebound = service
        .read(
            "talkak-a".into(),
            Some(2),
            project.into(),
            Some("2026-08-31T10:00:00Z".into()),
            Some("codex".into()),
            MAX_TRANSCRIPT_ENTRIES,
        )
        .unwrap()
        .unwrap();
    assert_eq!(PathBuf::from(rebound.path), new_path);
    assert_eq!(rebound.entries[0].text, "second run");
}

#[test]
fn a_resumed_run_can_keep_appending_to_the_same_record() {
    let temp = TempDir::new().unwrap();
    let project = "C:/work/app";
    let path = codex_record(
        temp.path(),
        "resumed",
        project,
        "2026-08-31T10:00:00Z",
        "before resume",
    );
    let service = TranscriptService::at_home(temp.path().to_path_buf());
    service
        .read(
            "talkak-a".into(),
            Some(1),
            project.into(),
            Some("2026-08-31T10:00:00Z".into()),
            Some("codex".into()),
            MAX_TRANSCRIPT_ENTRIES,
        )
        .unwrap()
        .unwrap();

    assert!(service
        .read(
            "talkak-a".into(),
            Some(2),
            project.into(),
            Some("2026-08-31T10:00:00Z".into()),
            Some("codex".into()),
            MAX_TRANSCRIPT_ENTRIES,
        )
        .unwrap()
        .is_none());

    let mut file = OpenOptions::new().append(true).open(&path).unwrap();
    writeln!(
        file,
        "{}",
        codex_turn("2099-08-31T11:00:00Z", "assistant", "after resume")
    )
    .unwrap();
    file.flush().unwrap();
    let resumed = service
        .read(
            "talkak-a".into(),
            Some(2),
            project.into(),
            Some("2026-08-31T10:00:00Z".into()),
            Some("codex".into()),
            MAX_TRANSCRIPT_ENTRIES,
        )
        .unwrap()
        .unwrap();

    assert_eq!(PathBuf::from(resumed.path), path);
    assert_eq!(resumed.total_entries, 2);
    assert_eq!(resumed.entries[1].text, "after resume");
}

#[test]
fn codex_discovery_accepts_the_timezone_neighbor_date_shard() {
    let temp = TempDir::new().unwrap();
    let project = "C:/work/app";
    let original = codex_record(
        temp.path(),
        "timezone-neighbor",
        project,
        "2026-08-31T00:00:00Z",
        "neighbor",
    );
    let directory = temp.path().join(".codex/sessions/2026/08/30");
    create_dir_all(&directory).unwrap();
    let expected = directory.join(original.file_name().unwrap());
    std::fs::rename(original, &expected).unwrap();

    let selected = discover_record(
        temp.path(),
        project,
        Some(parse_rfc3339_ms("2026-08-31T00:00:00Z").unwrap()),
        Some(TranscriptSource::Codex),
        None,
        None,
    )
    .unwrap()
    .unwrap();

    assert_eq!(selected.path, expected);
}

#[test]
fn codex_discovery_falls_back_when_an_agent_starts_days_after_its_shell() {
    let temp = TempDir::new().unwrap();
    let project = "C:/work/app";
    let original = codex_record(
        temp.path(),
        "late-agent",
        project,
        "2026-09-03T10:00:00Z",
        "late",
    );
    let directory = temp.path().join(".codex/sessions/2026/09/03");
    create_dir_all(&directory).unwrap();
    let expected = directory.join(original.file_name().unwrap());
    std::fs::rename(original, &expected).unwrap();

    let selected = discover_record(
        temp.path(),
        project,
        Some(parse_rfc3339_ms("2026-08-31T10:00:00Z").unwrap()),
        Some(TranscriptSource::Codex),
        None,
        None,
    )
    .unwrap()
    .unwrap();

    assert_eq!(selected.path, expected);
}
