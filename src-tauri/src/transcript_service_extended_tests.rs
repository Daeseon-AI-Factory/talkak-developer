use super::*;
use crate::agent_transcript::{collect_line_without_filter_for_test, MAX_TRANSCRIPT_TURN_CHARS};
use crate::transcript_line_filter::compact_record_relevance;
use session_broker::store::StoredSession;
use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::{Condvar, Mutex as TestMutex};
use std::thread;
use std::time::{Duration, Instant};
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
#[ignore = "local transcript cold/warm performance probe"]
fn local_cold_and_warm_cache_probe() {
    let project = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let Some(home) = home_dir() else {
        println!("no local home directory; skipped");
        return;
    };
    let discovery_started = Instant::now();
    let selected = discover_record(
        &home,
        &project,
        None,
        Some(TranscriptSource::Codex),
        None,
        None,
    )
    .unwrap();
    let discovery_elapsed = discovery_started.elapsed();
    let Some(selected) = selected else {
        println!("no local Codex record; skipped");
        return;
    };
    let selected_path = selected.path.clone();
    let parse_started = Instant::now();
    let parsed = BoundTranscript::open("local-performance-probe".into(), None, selected).unwrap();
    let parse_elapsed = parse_started.elapsed();
    let legacy_started = Instant::now();
    let (legacy, fast_relevant, fast_rejected, fallback) = legacy_codex_projection(&selected_path);
    let legacy_elapsed = legacy_started.elapsed();
    let service = TranscriptService::new(None);
    let cold_started = Instant::now();
    let Some(cold) = service
        .read(
            "local-performance-probe".into(),
            None,
            project,
            None,
            Some("codex".into()),
            MAX_TRANSCRIPT_ENTRIES,
        )
        .unwrap()
    else {
        println!("no local Codex record; skipped");
        return;
    };
    let cold_elapsed = cold_started.elapsed();
    let warm_started = Instant::now();
    let warm = service
        .read(
            "local-performance-probe".into(),
            None,
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            None,
            Some("codex".into()),
            MAX_TRANSCRIPT_ENTRIES,
        )
        .unwrap()
        .unwrap();
    let warm_elapsed = warm_started.elapsed();

    assert_eq!(warm.total_entries, cold.total_entries);
    assert_eq!(
        parsed.snapshot(MAX_TRANSCRIPT_ENTRIES).total_entries,
        cold.total_entries
    );
    assert_eq!(legacy.total_entries, cold.total_entries);
    println!(
        "discovery={}ms parse={}ms legacy_parse={}ms cold={}ms warm={}us turns={} fast_relevant={} fast_rejected={} fallback={} path={}",
        discovery_elapsed.as_millis(),
        parse_elapsed.as_millis(),
        legacy_elapsed.as_millis(),
        cold_elapsed.as_millis(),
        warm_elapsed.as_micros(),
        warm.total_entries,
        fast_relevant,
        fast_rejected,
        fallback,
        warm.path
    );
}

#[test]
#[ignore = "local Claude transcript cold/warm performance probe"]
fn local_claude_cold_and_warm_cache_probe() {
    let project = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let Some(home) = home_dir() else {
        println!("no local home directory; skipped");
        return;
    };
    let discovery_started = Instant::now();
    let selected = discover_record(
        &home,
        &project,
        None,
        Some(TranscriptSource::Claude),
        None,
        None,
    )
    .unwrap();
    let discovery_elapsed = discovery_started.elapsed();
    let Some(selected) = selected else {
        println!("no local Claude record; skipped");
        return;
    };
    let bytes = std::fs::metadata(&selected.path).unwrap().len();
    let parse_started = Instant::now();
    let parsed = BoundTranscript::open("local-claude-parse-probe".into(), None, selected).unwrap();
    let parse_elapsed = parse_started.elapsed();
    let parsed_lines = parsed.parsed_lines;

    let service = TranscriptService::new(None);
    let cold_started = Instant::now();
    let cold = service
        .read(
            "local-claude-cache-probe".into(),
            None,
            project.clone(),
            None,
            Some("claude".into()),
            MAX_TRANSCRIPT_ENTRIES,
        )
        .unwrap()
        .unwrap();
    let cold_elapsed = cold_started.elapsed();
    let warm_started = Instant::now();
    let warm = service
        .read(
            "local-claude-cache-probe".into(),
            None,
            project,
            None,
            Some("claude".into()),
            MAX_TRANSCRIPT_ENTRIES,
        )
        .unwrap()
        .unwrap();
    let warm_elapsed = warm_started.elapsed();

    assert_eq!(warm.total_entries, cold.total_entries);
    assert_eq!(
        parsed.snapshot(MAX_TRANSCRIPT_ENTRIES).total_entries,
        cold.total_entries
    );
    println!(
        "claude discovery={}ms parse={}ms cold={}ms warm={}us bytes={} lines={} turns={}",
        discovery_elapsed.as_millis(),
        parse_elapsed.as_millis(),
        cold_elapsed.as_millis(),
        warm_elapsed.as_micros(),
        bytes,
        parsed_lines,
        warm.total_entries,
    );
}

fn legacy_codex_projection(path: &Path) -> (AgentTranscript, usize, usize, usize) {
    let file = std::fs::File::open(path).unwrap();
    let mut collected = Collected::new();
    let (mut relevant, mut rejected, mut fallback) = (0, 0, 0);
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        match compact_record_relevance(TranscriptSource::Codex, &line) {
            Some(true) => relevant += 1,
            Some(false) => rejected += 1,
            None => fallback += 1,
        }
        collect_line_without_filter_for_test(
            TranscriptSource::Codex,
            &line,
            &mut collected,
            MAX_TRANSCRIPT_ENTRIES,
        );
    }
    (
        collected.snapshot(TranscriptSource::Codex, path, MAX_TRANSCRIPT_ENTRIES),
        relevant,
        rejected,
        fallback,
    )
}
