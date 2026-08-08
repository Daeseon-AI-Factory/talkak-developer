use crate::session_runtime::{
    OutputBuffer, ReadSessionRequest, ResizeSessionRequest, RuntimeError, SessionIdRequest,
    SessionRuntime, SpawnSessionRequest, WriteSessionRequest, MAX_OUTPUT_BYTES,
};
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
    (
        b"@echo off\r\n".to_vec(),
        b"echo talkak-result\r\n".to_vec(),
        b"talkak-result",
    )
}
