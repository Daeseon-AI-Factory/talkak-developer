//! Real-PTY tests for what an operator sees in the session list (launch and last-output times)
//! and for the back-pressure an attached stream applies to the reader thread.

use crate::runtime::{
    ReadSessionRequest, RunSessionRequest, SessionRuntime, SpawnSessionRequest, WriteSessionRequest,
};
use crate::store::now_ms;
use std::thread;
use std::time::{Duration, Instant};

const PTY_WAIT: Duration = Duration::from_secs(30);

#[test]
fn live_sessions_carry_launch_time_program_and_last_output_time() {
    let runtime = SessionRuntime::default();
    let (setup, input, expected) = default_shell_fixture();
    let cwd = std::env::current_dir().expect("test working directory should resolve");
    let before = now_ms();
    let started = runtime
        .spawn(SpawnSessionRequest {
            session_id: "listed".into(),
            cwd: Some(cwd.to_string_lossy().into_owned()),
            command: None,
            args: vec![],
            env: Vec::new(),
            cols: 80,
            rows: 24,
        })
        .expect("PTY should spawn");
    let after = now_ms();

    let listed = runtime.live_sessions();
    assert_eq!(listed.len(), 1);
    let session = &listed[0];
    assert_eq!(session.session_id, "listed");
    assert_eq!(session.run_id, started.run_id);
    assert!(session.running);
    let started_at = session
        .started_at_ms
        .expect("a spawned run has a launch time");
    assert!(
        (before..=after).contains(&started_at),
        "started_at_ms {started_at} outside spawn window {before}..={after}"
    );
    assert_eq!(
        session.cwd.as_deref(),
        Some(cwd.to_string_lossy().as_ref()),
        "the working directory is what the run was asked for"
    );
    assert_eq!(
        session.command, None,
        "no command means the OS default shell"
    );

    // The wire shape: the new fields are plain camelCase members with the rest.
    let encoded = serde_json::to_value(session).expect("encode");
    assert!(encoded.get("startedAtMs").is_some());
    assert!(encoded.get("lastOutputMs").is_some());
    assert!(encoded.get("cwd").is_some());
    assert!(encoded.get("command").is_some());

    runtime
        .write(WriteSessionRequest {
            session_id: "listed".into(),
            run_id: started.run_id,
            data: setup,
        })
        .expect("PTY should accept shell setup input");
    thread::sleep(Duration::from_millis(100));
    runtime
        .write(WriteSessionRequest {
            session_id: "listed".into(),
            run_id: started.run_id,
            data: input,
        })
        .expect("PTY should accept input");
    wait_for_output(&runtime, "listed", expected);

    let listed = runtime.live_sessions();
    let last_output = listed[0]
        .last_output_ms
        .expect("a run that produced output has a last-output time");
    assert!(
        last_output >= started_at,
        "last output {last_output} precedes launch {started_at}"
    );
    assert!(last_output <= now_ms());

    runtime
        .kill(RunSessionRequest {
            session_id: "listed".into(),
            run_id: started.run_id,
        })
        .expect("PTY should stop");
    wait_for_exit(&runtime, "listed");
}

#[test]
fn a_live_session_answer_from_an_older_broker_still_parses() {
    // A broker that predates these fields answers without them; the app must read it anyway.
    let older = r#"{"sessionId":"s","runId":2,"processId":10,"running":true}"#;
    let session: crate::runtime::LiveSession = serde_json::from_str(older).expect("parse");
    assert_eq!(session.started_at_ms, None);
    assert_eq!(session.last_output_ms, None);
    assert_eq!(session.cwd, None);
    assert_eq!(session.command, None);
}

/// Three times the ring in one burst, read by a deliberately slow attached stream: nothing may be
/// lost. Without the gate the reader thread overruns the ring long before the stream has sent its
/// second frame and every later frame carries `truncated`. Unix only for the producer command;
/// the gate itself is platform-free and unit-tested in `output.rs`.
#[cfg(unix)]
#[test]
fn an_attached_stream_loses_nothing_from_a_burst_three_times_the_ring() {
    const BURST: usize = 3 * 1024 * 1024;
    let runtime = SessionRuntime::default();
    let started = runtime
        .spawn(SpawnSessionRequest {
            session_id: "burst".into(),
            cwd: None,
            command: Some("/bin/sh".into()),
            args: vec![
                "-c".into(),
                format!("head -c {BURST} /dev/zero | tr '\\000' a"),
            ],
            env: Vec::new(),
            cols: 80,
            rows: 24,
        })
        .expect("PTY should spawn");
    let reader = runtime.attach("burst").expect("attach");

    let deadline = Instant::now() + PTY_WAIT;
    let mut after = 0;
    let mut seen = 0_usize;
    let mut frames = 0_usize;
    loop {
        assert!(Instant::now() < deadline, "burst did not finish in time");
        let read = reader
            .wait_read(after, Duration::from_secs(1))
            .expect("attached read");
        assert!(
            !read.truncated,
            "frame {frames} at {after} was truncated: the reader ran past the stream"
        );
        after = read.next;
        seen += read.bytes.iter().filter(|byte| **byte == b'a').count();
        frames += 1;
        if !read.running && read.read_closed && read.bytes.is_empty() {
            break;
        }
        // A renderer that is busy painting: far slower than the shell produces.
        thread::sleep(Duration::from_millis(15));
    }
    assert_eq!(
        seen, BURST,
        "bytes were lost between the PTY and the stream"
    );
    assert!(frames > 1);
    let _ = started;
    drop(reader);
    wait_for_exit(&runtime, "burst");
}

fn wait_for_output(runtime: &SessionRuntime, session_id: &str, needle: &[u8]) {
    let deadline = Instant::now() + PTY_WAIT;
    let mut cursor = 0;
    let mut collected = Vec::new();
    while Instant::now() < deadline {
        let read = runtime
            .read(ReadSessionRequest {
                session_id: session_id.into(),
                after: cursor,
            })
            .expect("PTY output should be readable");
        cursor = read.next;
        collected.extend(read.bytes);
        if collected
            .windows(needle.len())
            .any(|window| window == needle)
        {
            return;
        }
        thread::sleep(Duration::from_millis(10));
    }
    panic!(
        "timed out waiting for {:?}; output was {:?}",
        String::from_utf8_lossy(needle),
        String::from_utf8_lossy(&collected)
    );
}

fn wait_for_exit(runtime: &SessionRuntime, session_id: &str) {
    let deadline = Instant::now() + PTY_WAIT;
    while Instant::now() < deadline {
        let read = runtime
            .read(ReadSessionRequest {
                session_id: session_id.into(),
                after: 0,
            })
            .expect("status should remain readable");
        if !read.running && read.read_closed {
            return;
        }
        thread::sleep(Duration::from_millis(10));
    }
    panic!("timed out waiting for the PTY to finish");
}

#[cfg(unix)]
fn default_shell_fixture() -> (Vec<u8>, Vec<u8>, &'static [u8]) {
    (
        b"stty -echo\r\n".to_vec(),
        b"printf 'talkak-result\\n'\r\n".to_vec(),
        b"talkak-result",
    )
}

#[cfg(windows)]
fn default_shell_fixture() -> (Vec<u8>, Vec<u8>, &'static [u8]) {
    // `cd .` is a quiet no-op in PowerShell (the default now) and in cmd (the fallback).
    (
        b"cd .\r\n".to_vec(),
        b"echo talkak-result\r\n".to_vec(),
        b"talkak-result",
    )
}
