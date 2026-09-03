use super::*;
use crate::transcript_paths::claude_project_dir_name;
use session_broker::store::StoredSession;
use std::fs::{create_dir_all, FileTimes, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::time::{Duration, UNIX_EPOCH};
use tempfile::TempDir;

const OLD_ID: &str = "11111111-1111-4111-8111-111111111111";
const NEW_ID: &str = "22222222-2222-4222-8222-222222222222";

fn claude_record(home: &Path, project: &str, id: &str, at: &str, text: &str) -> PathBuf {
    let directory = home
        .join(".claude/projects")
        .join(claude_project_dir_name(project));
    create_dir_all(&directory).unwrap();
    let path = directory.join(format!("{id}.jsonl"));
    let system = serde_json::json!({
        "type": "system", "timestamp": at, "sessionId": id,
        "cwd": project, "isSidechain": false
    });
    let user = serde_json::json!({
        "type": "user", "timestamp": at,
        "message": {"role": "user", "content": "question"}
    });
    let assistant = assistant_turn(at, text);
    std::fs::write(&path, format!("{system}\n{user}\n{assistant}\n")).unwrap();
    path
}

fn assistant_turn(at: &str, text: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "assistant", "timestamp": at,
        "message": {"id": "message", "role": "assistant", "content": [
            {"type": "text", "text": text}
        ]}
    })
}

fn set_modified(path: &Path, at_ms: u64) {
    let file = OpenOptions::new().write(true).open(path).unwrap();
    file.set_times(FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_millis(at_ms)))
        .unwrap();
}

fn definition(
    session_id: &str,
    project: &str,
    run_id: u64,
    started_at_ms: u64,
    args: &[&str],
) -> StoredSession {
    StoredSession {
        session_id: session_id.into(),
        run_id: Some(run_id),
        cwd: Some(project.into()),
        command: Some("claude".into()),
        args: args.iter().map(|arg| (*arg).to_string()).collect(),
        cols: 100,
        rows: 30,
        started_at_ms,
    }
}

fn service_with_definition(
    temp: &TempDir,
    definition: &StoredSession,
) -> (TranscriptService, Arc<SessionStore>) {
    let store = Arc::new(SessionStore::at(temp.path().join("runtime-sessions")));
    store.record(definition).unwrap();
    let service = TranscriptService {
        home: Some(temp.path().to_path_buf()),
        store: Some(Arc::clone(&store)),
        cache: Arc::new(Mutex::new(HashMap::new())),
        cold_read_hook: None,
    };
    (service, store)
}

fn read(service: &TranscriptService, session_id: &str, project: &str) -> Option<AgentTranscript> {
    service
        .read(
            session_id.into(),
            None,
            project.into(),
            None,
            Some("claude".into()),
            MAX_TRANSCRIPT_ENTRIES,
        )
        .unwrap()
}

#[test]
fn explicit_resume_binds_the_matching_old_claude_session() {
    let temp = TempDir::new().unwrap();
    let project = "C:/work/app";
    let other_worktree = "C:/work/app-worktree";
    let wanted = claude_record(
        temp.path(),
        other_worktree,
        OLD_ID,
        "2026-08-30T08:00:00Z",
        "resumed",
    );
    claude_record(
        temp.path(),
        project,
        NEW_ID,
        "2026-08-30T09:00:00Z",
        "other",
    );
    let definition = definition(
        "talkak-resume",
        project,
        1,
        parse_rfc3339_ms("2026-08-31T10:00:00Z").unwrap() as u64,
        &["--resume", OLD_ID],
    );
    let (service, _) = service_with_definition(&temp, &definition);

    let transcript = read(&service, "talkak-resume", project).unwrap();
    assert_eq!(PathBuf::from(transcript.path), wanted);
    assert_eq!(transcript.entries[1].text, "resumed");
}

#[test]
fn continue_stays_unbound_when_two_same_project_records_advanced_after_launch() {
    let temp = TempDir::new().unwrap();
    let project = "C:/work/app";
    // Both records were written just now, after the launch below: mtime cannot say which of the
    // two same-cwd panes owns which, so neither binds.
    claude_record(
        temp.path(),
        project,
        OLD_ID,
        "2026-08-30T08:00:00Z",
        "older",
    );
    claude_record(
        temp.path(),
        project,
        NEW_ID,
        "2026-08-30T09:00:00Z",
        "newest",
    );
    for (session_id, args) in [
        ("talkak-continue-short", vec!["-c"]),
        ("talkak-continue-long", vec!["--continue"]),
    ] {
        let definition = definition(
            session_id,
            project,
            1,
            parse_rfc3339_ms("2026-08-31T10:00:00Z").unwrap() as u64,
            &args,
        );
        let (service, _) = service_with_definition(&temp, &definition);
        assert!(read(&service, session_id, project).is_none());
    }
}

#[test]
fn continue_binds_the_only_record_that_advanced_after_launch_as_probable() {
    let temp = TempDir::new().unwrap();
    let project = "C:/work/app";
    let started = parse_rfc3339_ms("2026-08-31T10:00:00Z").unwrap() as u64;
    let stale = claude_record(
        temp.path(),
        project,
        OLD_ID,
        "2026-08-30T08:00:00Z",
        "older",
    );
    // Untouched since before this run: not the record the resumed agent is writing.
    set_modified(&stale, started - 3_600_000);
    let advanced = claude_record(
        temp.path(),
        project,
        NEW_ID,
        "2026-08-30T09:00:00Z",
        "resumed here",
    );
    // A Windows-spelled project path resolves to the same Claude directory name.
    for (session_id, args, spelled) in [
        ("talkak-continue-short", vec!["-c"], "C:/work/app"),
        ("talkak-continue-long", vec!["--continue"], "C:\\work\\app"),
        ("talkak-resume-picker", vec!["--resume"], "C:\\work\\app"),
        (
            "talkak-resume-named",
            vec!["-r", "search term"],
            "C:/work/app",
        ),
    ] {
        let definition = definition(session_id, spelled, 1, started, &args);
        let (service, _) = service_with_definition(&temp, &definition);
        let transcript = read(&service, session_id, project).expect("the only advanced record");
        assert_eq!(PathBuf::from(&transcript.path), advanced);
        assert_eq!(transcript.binding, "probable");
        assert_eq!(transcript.entries[1].text, "resumed here");
    }
}

#[test]
fn fork_does_not_guess_an_old_record() {
    let temp = TempDir::new().unwrap();
    let project = "C:/work/app";
    claude_record(temp.path(), project, OLD_ID, "2026-08-30T08:00:00Z", "old");
    let started = 2_000_000_000_000;
    let definition = definition(
        "talkak-fork",
        project,
        1,
        started,
        &["--resume", OLD_ID, "--fork-session"],
    );
    let (service, _) = service_with_definition(&temp, &definition);
    assert!(read(&service, "talkak-fork", project).is_none());
}

#[test]
fn picker_and_named_resume_stay_unbound_without_exact_ownership() {
    let temp = TempDir::new().unwrap();
    let project = "C:/work/app";
    claude_record(temp.path(), project, OLD_ID, "2026-08-30T08:00:00Z", "old");
    claude_record(
        temp.path(),
        "C:/work/app-worktree",
        NEW_ID,
        "2026-08-31T10:00:00Z",
        "other",
    );
    for (session_id, args) in [
        ("talkak-picker", vec!["--resume"]),
        ("talkak-named", vec!["--resume", "search term"]),
    ] {
        let definition = definition(session_id, project, 1, 2_000_000_000_000, &args);
        let (service, _) = service_with_definition(&temp, &definition);
        assert!(read(&service, session_id, project).is_none());
    }
}

#[test]
fn destination_session_id_wins_over_fork_resume_source() {
    let temp = TempDir::new().unwrap();
    let project = "C:/work/app";
    claude_record(
        temp.path(),
        project,
        OLD_ID,
        "2026-08-30T08:00:00Z",
        "source",
    );
    let destination = claude_record(
        temp.path(),
        project,
        NEW_ID,
        "2026-08-31T10:00:00Z",
        "destination",
    );
    let definition = definition(
        "talkak-fork-destination",
        project,
        1,
        2_000_000_000_000,
        &["--session-id", NEW_ID, "--fork-session", "--resume", OLD_ID],
    );
    let (service, _) = service_with_definition(&temp, &definition);
    let transcript = read(&service, "talkak-fork-destination", project).unwrap();
    assert_eq!(PathBuf::from(transcript.path), destination);
    assert_eq!(transcript.entries[1].text, "destination");
}

#[test]
fn same_time_fork_candidates_are_ambiguous() {
    let temp = TempDir::new().unwrap();
    let project = "C:/work/app";
    let at = "2026-08-31T10:00:00Z";
    let started = parse_rfc3339_ms(at).unwrap() as u64;
    let first = claude_record(temp.path(), project, OLD_ID, at, "first");
    let second = claude_record(temp.path(), project, NEW_ID, at, "second");
    set_modified(&first, started + 1);
    set_modified(&second, started + 900);
    let definition = definition("talkak-fork-tie", project, 1, started, &["--fork-session"]);
    let (service, _) = service_with_definition(&temp, &definition);
    assert!(read(&service, "talkak-fork-tie", project).is_none());
}

#[test]
fn app_lifetime_continue_resumes_the_bound_file_when_it_alone_advanced() {
    let temp = TempDir::new().unwrap();
    let project = "C:/work/app";
    let at = "2026-08-31T10:00:00Z";
    let path = claude_record(temp.path(), project, OLD_ID, at, "before");
    let started = parse_rfc3339_ms(at).unwrap() as u64;
    let first = definition("talkak-lifetime", project, 1, started, &[]);
    let (service, store) = service_with_definition(&temp, &first);
    let exact = read(&service, "talkak-lifetime", project).unwrap();
    assert_eq!(PathBuf::from(&exact.path), path);
    assert_eq!(exact.binding, "exact");

    let resumed_at = system_time_ms(SystemTime::now()) as u64;
    store
        .record(&definition(
            "talkak-lifetime",
            project,
            2,
            resumed_at,
            &["--continue"],
        ))
        .unwrap();
    // Nothing advanced yet: the new run stays pending rather than showing the old binding.
    assert!(read(&service, "talkak-lifetime", project).is_none());

    let mut file = OpenOptions::new().append(true).open(&path).unwrap();
    writeln!(file, "{}", assistant_turn("2026-08-31T10:01:00Z", "after")).unwrap();
    file.flush().unwrap();
    let resumed = read(&service, "talkak-lifetime", project).expect("the resumed record");
    assert_eq!(PathBuf::from(&resumed.path), path);
    assert_eq!(resumed.binding, "probable");
    assert_eq!(resumed.entries[1].text, "before\n\nafter");
    assert_ne!(resumed.revision, exact.revision);

    // A second record advancing in the same project makes ownership ambiguous again.
    let other = claude_record(temp.path(), project, NEW_ID, at, "other pane");
    store
        .record(&definition(
            "talkak-lifetime",
            project,
            3,
            system_time_ms(SystemTime::now()) as u64,
            &["--continue"],
        ))
        .unwrap();
    writeln!(file, "{}", assistant_turn("2026-08-31T10:02:00Z", "later")).unwrap();
    file.flush().unwrap();
    set_modified(&other, system_time_ms(SystemTime::now()) as u64 + 500);
    assert!(read(&service, "talkak-lifetime", project).is_none());
}

#[test]
fn app_lifetime_fork_never_reuses_the_previously_bound_file() {
    let temp = TempDir::new().unwrap();
    let project = "C:/work/app";
    let at = "2026-08-31T10:00:00Z";
    let path = claude_record(temp.path(), project, OLD_ID, at, "before");
    let first = definition(
        "talkak-fork-lifetime",
        project,
        1,
        parse_rfc3339_ms(at).unwrap() as u64,
        &[],
    );
    let (service, store) = service_with_definition(&temp, &first);
    assert!(read(&service, "talkak-fork-lifetime", project).is_some());

    store
        .record(&definition(
            "talkak-fork-lifetime",
            project,
            2,
            system_time_ms(SystemTime::now()) as u64,
            &["--resume", OLD_ID, "--fork-session"],
        ))
        .unwrap();
    let mut file = OpenOptions::new().append(true).open(path).unwrap();
    writeln!(
        file,
        "{}",
        assistant_turn("2026-08-31T10:01:00Z", "old file changed")
    )
    .unwrap();
    file.flush().unwrap();

    assert!(read(&service, "talkak-fork-lifetime", project).is_none());
}
