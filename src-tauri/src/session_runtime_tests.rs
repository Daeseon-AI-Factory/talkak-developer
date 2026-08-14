use crate::session_runtime::{
    InitialCursorPositionQuery, OutputBuffer, ReadSessionRequest, ResizeSessionRequest,
    RuntimeError, SessionIdRequest, SessionRuntime, SpawnSessionRequest, WriteSessionRequest,
    MAX_OUTPUT_BYTES,
};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

#[test]
fn output_buffer_keeps_a_bounded_replay_window() {
    let mut output = OutputBuffer::default();
    output.append(&vec![b'a'; MAX_OUTPUT_BYTES]);
    output.append(b"tail");

    let read = output.read_for_test(0);
    assert!(read.truncated);
    assert_eq!(read.start, 4);
}

#[test]
fn initial_cursor_query_is_answered_once_and_removed_from_replay() {
    let mut query = InitialCursorPositionQuery::new(true);

    let first = query.observe(b"prefix\x1b[");
    let second = query.observe(b"6n middle \x1b[6n suffix");
    let third = query.observe(b" ordinary");

    assert_eq!(first.output, b"prefix");
    assert!(!first.should_respond);
    assert_eq!(second.output, b" middle \x1b[6n suffix");
    assert!(second.should_respond);
    assert_eq!(third.output, b" ordinary");
    assert!(!third.should_respond);
    assert!(query.finish().is_empty());
}

#[test]
fn cursor_query_filter_can_be_disabled_for_non_conpty_hosts() {
    let mut query = InitialCursorPositionQuery::new(false);
    let output = query.observe(b"\x1b[6n");

    assert_eq!(output.output, b"\x1b[6n");
    assert!(!output.should_respond);
}

#[test]
fn spawn_rejects_relative_working_directories() {
    let runtime = SessionRuntime::default();
    let error = runtime
        .spawn(SpawnSessionRequest {
            session_id: "relative-cwd".into(),
            cwd: Some("relative/path".into()),
            command: None,
            args: vec![],
            cols: 80,
            rows: 24,
        })
        .expect_err("relative cwd must be rejected");

    assert!(matches!(error, RuntimeError::InvalidRequest(_)));
}

#[test]
fn native_pty_supports_spawn_write_read_resize_and_kill() {
    let runtime = SessionRuntime::default();
    let (setup, input, expected) = default_shell_fixture();
    let cwd = std::env::current_dir().expect("test working directory should resolve");
    let started = runtime
        .spawn(SpawnSessionRequest {
            session_id: "round-trip".into(),
            cwd: Some(cwd.to_string_lossy().into_owned()),
            command: None,
            args: vec![],
            cols: 80,
            rows: 24,
        })
        .expect("PTY should spawn");
    assert!(started.running);

    runtime
        .write(WriteSessionRequest {
            session_id: "round-trip".into(),
            data: setup,
        })
        .expect("PTY should accept shell setup input");
    // Exact test settling interval; it is not a product latency guarantee.
    thread::sleep(Duration::from_millis(100));
    runtime
        .write(WriteSessionRequest {
            session_id: "round-trip".into(),
            data: input,
        })
        .expect("PTY should accept input");
    wait_for_output(&runtime, "round-trip", 0, expected);
    runtime
        .resize(ResizeSessionRequest {
            session_id: "round-trip".into(),
            cols: 100,
            rows: 40,
        })
        .expect("PTY should resize");

    let stopped = runtime
        .kill(SessionIdRequest {
            session_id: "round-trip".into(),
        })
        .expect("PTY should stop");
    assert!(!stopped.running);
    wait_for_read_closed(&runtime, "round-trip");
}

#[test]
fn native_pty_closes_after_command_exits_without_kill() {
    let runtime = SessionRuntime::default();
    let cwd = std::env::current_dir().expect("test working directory should resolve");
    let (command, args) = natural_exit_fixture();
    runtime
        .spawn(SpawnSessionRequest {
            session_id: "natural-exit".into(),
            cwd: Some(cwd.to_string_lossy().into_owned()),
            command: Some(command.into()),
            args,
            cols: 80,
            rows: 24,
        })
        .expect("short-lived PTY command should spawn");

    wait_for_read_closed(&runtime, "natural-exit");
}

#[test]
fn dropping_a_runtime_with_a_live_session_returns() {
    let runtime = SessionRuntime::default();
    let cwd = std::env::current_dir().expect("test working directory should resolve");
    runtime
        .spawn(SpawnSessionRequest {
            session_id: "drop-live-runtime".into(),
            cwd: Some(cwd.to_string_lossy().into_owned()),
            command: None,
            args: vec![],
            cols: 80,
            rows: 24,
        })
        .expect("PTY should spawn");

    let (finished_tx, finished_rx) = mpsc::channel();
    thread::spawn(move || {
        drop(runtime);
        let _ = finished_tx.send(());
    });

    finished_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("dropping a runtime must not synchronously wait for PTY master close");
}

#[test]
fn discard_rejects_a_running_session() {
    let runtime = SessionRuntime::default();
    let cwd = std::env::current_dir().expect("test working directory should resolve");
    runtime
        .spawn(SpawnSessionRequest {
            session_id: "discard-running".into(),
            cwd: Some(cwd.to_string_lossy().into_owned()),
            command: None,
            args: vec![],
            cols: 80,
            rows: 24,
        })
        .expect("PTY should spawn");

    let error = runtime
        .discard(SessionIdRequest {
            session_id: "discard-running".into(),
        })
        .expect_err("a running session must not be discarded");
    assert!(matches!(error, RuntimeError::RunningSession(_)));

    runtime
        .kill(SessionIdRequest {
            session_id: "discard-running".into(),
        })
        .expect("PTY should stop");
}

#[test]
fn discard_allows_an_exited_session_id_to_start_again() {
    let runtime = SessionRuntime::default();
    let cwd = std::env::current_dir().expect("test working directory should resolve");
    let request = SpawnSessionRequest {
        session_id: "restart-exited".into(),
        cwd: Some(cwd.to_string_lossy().into_owned()),
        command: None,
        args: vec![],
        cols: 80,
        rows: 24,
    };
    let first = runtime.spawn(request.clone()).expect("PTY should spawn");
    runtime
        .kill(SessionIdRequest {
            session_id: request.session_id.clone(),
        })
        .expect("PTY should stop");
    runtime
        .discard(SessionIdRequest {
            session_id: request.session_id.clone(),
        })
        .expect("an exited session should be discarded");
    assert!(runtime
        .snapshot(SessionIdRequest {
            session_id: request.session_id.clone(),
        })
        .expect("snapshot should succeed")
        .is_none());

    let restarted = runtime
        .spawn(request)
        .expect("the session id should be reusable");
    assert!(restarted.running);
    assert_ne!(restarted.run_id, first.run_id);
    runtime
        .kill(SessionIdRequest {
            session_id: restarted.session_id,
        })
        .expect("restarted PTY should stop");
}

fn wait_for_output(runtime: &SessionRuntime, session_id: &str, after: u64, needle: &[u8]) {
    // Exact test timeout; it is not a runtime timeout or product guarantee.
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut cursor = after;
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

fn wait_for_read_closed(runtime: &SessionRuntime, session_id: &str) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        let read = runtime
            .read(ReadSessionRequest {
                session_id: session_id.into(),
                after: 0,
            })
            .expect("stopped PTY status should remain readable");
        if read.read_closed {
            assert!(!read.running);
            assert!(read.read_error.is_none());
            return;
        }
        thread::sleep(Duration::from_millis(10));
    }
    panic!("timed out waiting for stopped PTY reader to close");
}

#[cfg(unix)]
fn default_shell_fixture() -> (Vec<u8>, Vec<u8>, &'static [u8]) {
    (
        b"stty -echo\r\n".to_vec(),
        b"printf 'talkak-result\\n'\r\n".to_vec(),
        b"talkak-result",
    )
}

#[cfg(unix)]
fn natural_exit_fixture() -> (&'static str, Vec<String>) {
    ("/bin/sh", vec!["-c".into(), "exit 0".into()])
}

#[cfg(windows)]
fn default_shell_fixture() -> (Vec<u8>, Vec<u8>, &'static [u8]) {
    (
        b"@echo off\r\n".to_vec(),
        b"echo talkak-result\r\n".to_vec(),
        b"talkak-result",
    )
}

#[cfg(windows)]
fn natural_exit_fixture() -> (&'static str, Vec<String>) {
    (
        "cmd.exe",
        vec!["/D".into(), "/S".into(), "/C".into(), "exit /B 0".into()],
    )
}
