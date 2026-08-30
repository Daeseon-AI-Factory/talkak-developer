use crate::runtime::{
    command_for_request, lock, InitialCursorPositionQuery, OutputBuffer, ReadSessionRequest,
    ResizeSessionRequest, RunSessionRequest, RuntimeError, SessionIdRequest, SessionRuntime,
    SpawnSessionRequest, WriteSessionRequest, MAX_OUTPUT_BYTES,
};
use crate::store::SessionStore;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[test]
fn a_poisoned_runtime_lock_recovers_instead_of_bricking_every_later_request() {
    let value = Arc::new(Mutex::new(1));
    let worker_value = Arc::clone(&value);
    let panicked = thread::spawn(move || {
        let _guard = worker_value.lock().expect("first lock");
        panic!("intentional poison");
    })
    .join();
    assert!(panicked.is_err());

    *lock(&value, "test").expect("poisoned lock should recover") = 2;

    assert!(
        !value.is_poisoned(),
        "recovery should clear the poison flag"
    );
    assert_eq!(*value.lock().expect("later lock"), 2);
}

#[test]
fn an_inherited_no_color_never_reaches_a_pane() {
    // The broker outlives the app that starts it, so whatever environment launched it is stamped on
    // every shell it will ever open. Started once from a terminal carrying NO_COLOR=1, it set
    // PowerShell's OutputRendering to PlainText in every pane while TERM and COLORTERM sat there
    // claiming the terminal was colour-capable.
    std::env::set_var("NO_COLOR", "1");
    let command = command_for_request(&SpawnSessionRequest {
        session_id: "no-color".into(),
        cwd: None,
        command: None,
        args: Vec::new(),
        cols: 80,
        rows: 24,
    });
    std::env::remove_var("NO_COLOR");

    assert!(
        command.get_env("NO_COLOR").is_none(),
        "NO_COLOR was inherited into the pane environment"
    );
    assert_eq!(
        command.get_env("TERM").map(|value| value.to_string_lossy()),
        Some("xterm-256color".into()),
        "the pane must still be told what it is talking to"
    );
    assert_eq!(
        command
            .get_env("COLORTERM")
            .map(|value| value.to_string_lossy()),
        Some("truecolor".into())
    );
}

#[test]
fn a_disabling_clicolor_is_dropped_but_a_deliberate_one_survives() {
    // The macOS spelling of the same instruction. Only the negative form goes — this product has to
    // behave the same on both platforms, and someone who forces colour on meant it.
    fn build(id: &str) -> portable_pty::CommandBuilder {
        command_for_request(&SpawnSessionRequest {
            session_id: id.into(),
            cwd: None,
            command: None,
            args: Vec::new(),
            cols: 80,
            rows: 24,
        })
    }

    std::env::set_var("CLICOLOR", "0");
    std::env::set_var("CLICOLOR_FORCE", "1");
    let disabled = build("clicolor-off");
    std::env::set_var("CLICOLOR", "1");
    let chosen = build("clicolor-on");
    std::env::remove_var("CLICOLOR");
    std::env::remove_var("CLICOLOR_FORCE");

    assert!(
        disabled.get_env("CLICOLOR").is_none(),
        "CLICOLOR=0 was inherited into the pane environment"
    );
    assert_eq!(
        disabled
            .get_env("CLICOLOR_FORCE")
            .map(|value| value.to_string_lossy()),
        Some("1".into()),
        "the override a user set on purpose must survive"
    );
    assert_eq!(
        chosen
            .get_env("CLICOLOR")
            .map(|value| value.to_string_lossy()),
        Some("1".into()),
        "CLICOLOR=1 is someone choosing colour, not refusing it"
    );
}

#[cfg(windows)]
#[test]
fn the_default_windows_shell_is_a_powershell_when_one_is_installed() {
    // cmd.exe answers a developer's first `ls` with "not recognized"; PowerShell aliases it.
    let command = command_for_request(&SpawnSessionRequest {
        session_id: "default-shell".into(),
        cwd: None,
        command: None,
        args: Vec::new(),
        cols: 80,
        rows: 24,
    });
    let argv = command.get_argv();
    let program = argv[0].to_string_lossy().to_ascii_lowercase();
    assert!(
        program.ends_with("pwsh.exe") || program.ends_with("powershell.exe"),
        "expected a PowerShell default, got {program:?}"
    );
    assert!(
        argv.iter().any(|argument| argument == "-NoLogo"),
        "the banner should be suppressed: {argv:?}"
    );
}

#[test]
fn a_spawn_tells_the_child_it_is_talking_to_a_colour_terminal() {
    // A Windows GUI process inherits neither variable, so without this every colour-capable CLI
    // in a pane fell back to monochrome. The renderer is xterm.js on both platforms.
    let command = command_for_request(&SpawnSessionRequest {
        session_id: "colour".into(),
        cwd: None,
        command: None,
        args: Vec::new(),
        cols: 80,
        rows: 24,
    });
    let environment = command.iter_full_env_as_str().collect::<Vec<_>>();
    assert!(
        environment.contains(&("TERM", "xterm-256color")),
        "TERM missing from {environment:?}"
    );
    assert!(
        environment.contains(&("COLORTERM", "truecolor")),
        "COLORTERM missing from {environment:?}"
    );
}

#[test]
fn a_real_child_process_reads_the_colour_terminal_variables_back() {
    // The builder assertion above only proves intent. This spawns through the same path a pane
    // uses and reads what the child actually saw.
    let runtime = SessionRuntime::default();
    let cwd = std::env::current_dir().expect("test working directory should resolve");
    let (command, args) = if cfg!(windows) {
        (
            "cmd.exe",
            vec![
                "/D".to_string(),
                "/S".to_string(),
                "/C".to_string(),
                "echo TERM=%TERM% COLORTERM=%COLORTERM%".to_string(),
            ],
        )
    } else {
        (
            "/bin/sh",
            vec![
                "-c".to_string(),
                "echo TERM=$TERM COLORTERM=$COLORTERM".to_string(),
            ],
        )
    };
    runtime
        .spawn(SpawnSessionRequest {
            session_id: "colour-echo".into(),
            cwd: Some(cwd.to_string_lossy().into_owned()),
            command: Some(command.into()),
            args,
            cols: 80,
            rows: 24,
        })
        .expect("the echo command should spawn");
    let _ = wait_for_read_closed(&runtime, "colour-echo");
    let read = runtime
        .read(ReadSessionRequest {
            session_id: "colour-echo".into(),
            after: 0,
        })
        .expect("the finished session should stay readable");
    let output = String::from_utf8_lossy(&read.bytes);
    assert!(
        output.contains("TERM=xterm-256color"),
        "child did not see TERM; output was {output:?}"
    );
    assert!(
        output.contains("COLORTERM=truecolor"),
        "child did not see COLORTERM; output was {output:?}"
    );
}

#[test]
fn eight_panes_run_at_once_without_reading_each_other() {
    // The product is panes and pages side by side, and every other PTY test here uses one session.
    // This holds eight open at the same time, gives each a marker only it is told, and checks that
    // each pane sees its own and none of the others.
    const PANES: usize = 8;
    let runtime = SessionRuntime::default();
    let (setup, _input, _expected) = default_shell_fixture();
    let cwd = std::env::current_dir().expect("test working directory should resolve");
    let ids = (0..PANES).map(|n| format!("pane-{n}")).collect::<Vec<_>>();
    let mut runs = Vec::new();

    for id in &ids {
        let started = runtime
            .spawn(SpawnSessionRequest {
                session_id: id.clone(),
                cwd: Some(cwd.to_string_lossy().into_owned()),
                command: None,
                args: vec![],
                cols: 80,
                rows: 24,
            })
            .unwrap_or_else(|error| panic!("{id} should spawn: {error}"));
        assert!(started.running, "{id} should be running");
        runs.push(started.run_id);
    }

    for (id, run_id) in ids.iter().zip(&runs) {
        runtime
            .write(WriteSessionRequest {
                session_id: id.clone(),
                run_id: *run_id,
                data: setup.clone(),
            })
            .unwrap_or_else(|error| panic!("{id} should accept shell setup: {error}"));
    }
    // Exact test settling interval; it is not a product latency guarantee.
    thread::sleep(Duration::from_millis(200));

    for (index, (id, run_id)) in ids.iter().zip(&runs).enumerate() {
        let line = format!("echo talkak-pane-{index}\r\n");
        runtime
            .write(WriteSessionRequest {
                session_id: id.clone(),
                run_id: *run_id,
                data: line.into_bytes(),
            })
            .unwrap_or_else(|error| panic!("{id} should accept input: {error}"));
    }

    for (index, id) in ids.iter().enumerate() {
        wait_for_output(&runtime, id, 0, format!("talkak-pane-{index}").as_bytes());
    }

    // Isolation: no pane may carry another pane's marker.
    for (index, id) in ids.iter().enumerate() {
        let read = runtime
            .read(ReadSessionRequest {
                session_id: id.clone(),
                after: 0,
            })
            .unwrap_or_else(|error| panic!("{id} should stay readable: {error}"));
        let seen = String::from_utf8_lossy(&read.bytes).into_owned();
        for other in (0..PANES).filter(|other| *other != index) {
            assert!(
                !seen.contains(&format!("talkak-pane-{other}")),
                "{id} saw pane {other}'s output: {seen:?}"
            );
        }
    }

    for (id, run_id) in ids.iter().zip(&runs) {
        let stopped = runtime
            .kill(RunSessionRequest {
                session_id: id.clone(),
                run_id: *run_id,
            })
            .unwrap_or_else(|error| panic!("{id} should stop: {error}"));
        assert!(!stopped.running, "{id} should report stopped");
    }
}

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
            run_id: started.run_id,
            data: setup,
        })
        .expect("PTY should accept shell setup input");
    // Exact test settling interval; it is not a product latency guarantee.
    thread::sleep(Duration::from_millis(100));
    runtime
        .write(WriteSessionRequest {
            session_id: "round-trip".into(),
            run_id: started.run_id,
            data: input,
        })
        .expect("PTY should accept input");
    wait_for_output(&runtime, "round-trip", 0, expected);
    runtime
        .resize(ResizeSessionRequest {
            session_id: "round-trip".into(),
            run_id: started.run_id,
            cols: 100,
            rows: 40,
        })
        .expect("PTY should resize");

    runtime
        .kill(RunSessionRequest {
            session_id: "round-trip".into(),
            run_id: started.run_id,
        })
        .expect("PTY should stop");
    assert!(wait_for_process_exit(&runtime, "round-trip").is_some());
    let _ = wait_for_read_closed(&runtime, "round-trip");
}

#[test]
fn native_pty_closes_after_command_exits_without_kill() {
    let runtime = SessionRuntime::default();
    let cwd = std::env::current_dir().expect("test working directory should resolve");
    let (command, args) = natural_exit_fixture();
    let started = runtime
        .spawn(SpawnSessionRequest {
            session_id: "natural-exit".into(),
            cwd: Some(cwd.to_string_lossy().into_owned()),
            command: Some(command.into()),
            args,
            cols: 80,
            rows: 24,
        })
        .expect("short-lived PTY command should spawn");

    assert_eq!(wait_for_read_closed(&runtime, "natural-exit"), Some(7));
    let stopped = runtime
        .kill(RunSessionRequest {
            session_id: "natural-exit".into(),
            run_id: started.run_id,
        })
        .expect("stopping an already exited PTY should be idempotent");
    assert!(!stopped.running);
    assert_eq!(stopped.exit_code, Some(7));
}

#[test]
fn native_interactive_shell_reports_exit_without_waiting_for_reader_close() {
    let runtime = SessionRuntime::default();
    let cwd = std::env::current_dir().expect("test working directory should resolve");
    let started = runtime
        .spawn(SpawnSessionRequest {
            session_id: "interactive-exit".into(),
            cwd: Some(cwd.to_string_lossy().into_owned()),
            command: None,
            args: vec![],
            cols: 80,
            rows: 24,
        })
        .expect("interactive PTY should spawn");

    runtime
        .write(WriteSessionRequest {
            session_id: "interactive-exit".into(),
            run_id: started.run_id,
            data: b"exit\r\n".to_vec(),
        })
        .expect("interactive PTY should accept exit input");

    assert!(wait_for_process_exit(&runtime, "interactive-exit").is_some());
}

#[test]
fn stale_run_mutations_are_rejected() {
    let runtime = SessionRuntime::default();
    let cwd = std::env::current_dir().expect("test working directory should resolve");
    let started = runtime
        .spawn(SpawnSessionRequest {
            session_id: "stale-mutation".into(),
            cwd: Some(cwd.to_string_lossy().into_owned()),
            command: None,
            args: vec![],
            cols: 80,
            rows: 24,
        })
        .expect("PTY should spawn");
    let stale_run_id = started.run_id + 1;

    assert!(matches!(
        runtime.write(WriteSessionRequest {
            session_id: "stale-mutation".into(),
            run_id: stale_run_id,
            data: b"ignored".to_vec(),
        }),
        Err(RuntimeError::Process(message)) if message == "session run changed"
    ));
    assert!(matches!(
        runtime.resize(ResizeSessionRequest {
            session_id: "stale-mutation".into(),
            run_id: stale_run_id,
            cols: 100,
            rows: 40,
        }),
        Err(RuntimeError::Process(message)) if message == "session run changed"
    ));
    assert!(matches!(
        runtime.kill(RunSessionRequest {
            session_id: "stale-mutation".into(),
            run_id: stale_run_id,
        }),
        Err(RuntimeError::Process(message)) if message == "session run changed"
    ));

    runtime
        .kill(RunSessionRequest {
            session_id: "stale-mutation".into(),
            run_id: started.run_id,
        })
        .expect("PTY should stop");
    let _ = wait_for_read_closed(&runtime, "stale-mutation");
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
    let started = runtime
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
        .kill(RunSessionRequest {
            session_id: "discard-running".into(),
            run_id: started.run_id,
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
        .kill(RunSessionRequest {
            session_id: request.session_id.clone(),
            run_id: first.run_id,
        })
        .expect("PTY should stop");
    assert!(wait_for_process_exit(&runtime, &request.session_id).is_some());
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
        .kill(RunSessionRequest {
            session_id: restarted.session_id.clone(),
            run_id: restarted.run_id,
        })
        .expect("restarted PTY should stop");
}

/// How long a test waits on a real PTY. It is a test timeout, not a runtime timeout or a product
/// guarantee. Generous on purpose: the suite spawns a shell per test, and a cold `pwsh` start under
/// that contention ran well past five seconds, failing three tests that pass when run one at a
/// time. A passing test returns the moment it sees what it wants, so a longer deadline only changes
/// how long a genuine failure takes to report.
const PTY_WAIT: Duration = Duration::from_secs(30);

fn wait_for_output(runtime: &SessionRuntime, session_id: &str, after: u64, needle: &[u8]) {
    let deadline = Instant::now() + PTY_WAIT;
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

fn wait_for_read_closed(runtime: &SessionRuntime, session_id: &str) -> Option<u32> {
    let deadline = Instant::now() + PTY_WAIT;
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
            return read.exit_code;
        }
        thread::sleep(Duration::from_millis(10));
    }
    panic!("timed out waiting for stopped PTY reader to close");
}

fn wait_for_process_exit(runtime: &SessionRuntime, session_id: &str) -> Option<u32> {
    let deadline = Instant::now() + PTY_WAIT;
    while Instant::now() < deadline {
        let read = runtime
            .read(ReadSessionRequest {
                session_id: session_id.into(),
                after: 0,
            })
            .expect("interactive PTY status should remain readable");
        if !read.running {
            return read.exit_code;
        }
        thread::sleep(Duration::from_millis(10));
    }
    panic!("timed out waiting for interactive PTY process to exit");
}

/// Internal persistence on both platforms: a new runtime over the same store root finds the
/// previous session's definition and output. This does not claim a product recovery workflow.
#[test]
fn a_recorded_session_and_its_output_survive_a_new_runtime_over_the_same_root() {
    let root = std::env::temp_dir().join(format!(
        "talkak-runtime-restart-{}-{:?}",
        std::process::id(),
        thread::current().id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    let (setup, probe, needle) = default_shell_fixture();
    let cwd = std::env::current_dir().expect("test working directory should resolve");

    let started = {
        let runtime = SessionRuntime::with_store(SessionStore::at(&root));
        assert!(runtime.persists(), "store root should be writable");
        let started = runtime
            .spawn(SpawnSessionRequest {
                session_id: "restart-me".into(),
                cwd: Some(cwd.to_string_lossy().into_owned()),
                command: None,
                args: vec![],
                cols: 80,
                rows: 24,
            })
            .expect("PTY should spawn");
        for chunk in [setup, probe] {
            runtime
                .write(WriteSessionRequest {
                    session_id: "restart-me".into(),
                    run_id: started.run_id,
                    data: chunk,
                })
                .expect("PTY should accept input");
            thread::sleep(Duration::from_millis(100));
        }
        wait_for_output(&runtime, "restart-me", 0, needle);
        let _ = runtime.kill(RunSessionRequest {
            session_id: "restart-me".into(),
            run_id: started.run_id,
        });
        started
    };
    assert!(started.run_id > 0);

    // A brand-new runtime over the same internal store.
    let restarted = SessionRuntime::with_store(SessionStore::at(&root));
    let restorable = restarted.restorable();
    assert_eq!(restorable.len(), 1, "one session should be restorable");
    assert_eq!(restorable[0].session.session_id, "restart-me");
    assert_eq!(
        restorable[0].session.cwd.as_deref(),
        Some(cwd.to_string_lossy().as_ref()),
        "the working directory must come back so the session can be relaunched in place"
    );
    let stored = restarted.stored_output("restart-me");
    assert!(
        stored.windows(needle.len()).any(|window| window == needle),
        "stored output should contain the probe result"
    );

    // Discarding is the explicit throw-away, so a later restart must not offer it again.
    restarted
        .discard(SessionIdRequest {
            session_id: "restart-me".into(),
        })
        .expect_err("a session absent from this runtime cannot be discarded");
    let _ = std::fs::remove_dir_all(&root);
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
    ("/bin/sh", vec!["-c".into(), "exit 7".into()])
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

#[cfg(windows)]
fn natural_exit_fixture() -> (&'static str, Vec<String>) {
    (
        "cmd.exe",
        vec!["/D".into(), "/S".into(), "/C".into(), "exit /B 7".into()],
    )
}
