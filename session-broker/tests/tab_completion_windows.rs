//! Tab completion is table stakes for a terminal. This drives the engine exactly the way a pane
//! does — default shell (pwsh/PowerShell), ConPTY, byte writes — sends `cd C:\Win` + TAB, and
//! expects PSReadLine to complete it. If this passes, the backend chain is whole and any
//! completion failure lives above the PTY (renderer focus, or the program running inside).

#![cfg(windows)]

use session_broker::runtime::{
    ReadSessionRequest, SessionRuntime, SpawnSessionRequest, WriteSessionRequest,
};
use std::time::{Duration, Instant};

#[test]
fn pressing_tab_completes_a_path_in_the_default_shell() {
    let runtime = SessionRuntime::default();
    let spawned = runtime
        .spawn(SpawnSessionRequest {
            session_id: "tab-completion".into(),
            cwd: Some("C:\\".into()),
            command: None,
            args: Vec::new(),
            cols: 100,
            rows: 30,
        })
        .expect("default shell should spawn");
    assert!(spawned.running);

    // Let the shell finish starting (PSReadLine loads during the first prompt).
    wait_for(&runtime, 0, |text| text.contains(">"), "first prompt");

    runtime
        .write(WriteSessionRequest {
            session_id: "tab-completion".into(),
            run_id: spawned.run_id,
            data: b"cd C:\\Win".to_vec(),
        })
        .expect("typing should reach the shell");
    // PSReadLine syntax-highlights the echo (ANSI colour between "cd" and the path), so only the
    // path is a contiguous needle.
    let before_tab = wait_for(&runtime, 0, |text| text.contains("C:\\Win"), "typed text");

    runtime
        .write(WriteSessionRequest {
            session_id: "tab-completion".into(),
            run_id: spawned.run_id,
            data: b"\t".to_vec(),
        })
        .expect("TAB should reach the shell");

    // PSReadLine redraws the line with the completed candidate (C:\Windows on every Windows).
    wait_for(
        &runtime,
        before_tab,
        |text| text.contains("Windows"),
        "tab completion",
    );

    let _ = runtime.kill(session_broker::runtime::RunSessionRequest {
        session_id: "tab-completion".into(),
        run_id: spawned.run_id,
    });
}

/// Polls the replay buffer from `after` until `check` passes; returns the cursor reached.
fn wait_for(
    runtime: &SessionRuntime,
    after: u64,
    check: impl Fn(&str) -> bool,
    what: &str,
) -> u64 {
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut collected = String::new();
    let mut cursor = after;
    loop {
        let read = runtime
            .read(ReadSessionRequest {
                session_id: "tab-completion".into(),
                after: cursor,
            })
            .expect("output should stay readable");
        cursor = read.next;
        collected.push_str(&String::from_utf8_lossy(&read.bytes));
        if check(&collected) {
            return cursor;
        }
        assert!(
            Instant::now() < deadline,
            "{what} never appeared; saw: {collected:?}"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
}
