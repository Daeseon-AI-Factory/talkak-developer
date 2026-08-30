//! The app-side client against a REAL detached broker — the exact wiring a pane uses. The broker
//! binary must exist in session-broker/target/{debug,release}; CI builds it before these tests.

use crate::session_runtime::{
    ReadSessionRequest, RunSessionRequest, SessionIdRequest, SessionRuntime, SpawnSessionRequest,
    WriteSessionRequest,
};
use std::time::{Duration, Instant};

fn unique_endpoint(tag: &str) -> String {
    #[cfg(unix)]
    {
        format!("/tmp/talkak-dev-client-{tag}-{}.sock", std::process::id())
    }
    #[cfg(windows)]
    {
        format!(r"\\.\pipe\talkak-dev-client-{tag}-{}", std::process::id())
    }
}

fn long_lived() -> (Option<String>, Vec<String>) {
    #[cfg(unix)]
    {
        (Some("/bin/sh".into()), vec!["-i".into()])
    }
    #[cfg(windows)]
    {
        (None, Vec::new())
    }
}

#[test]
fn the_client_runs_a_full_session_lifecycle_through_a_detached_broker() {
    let data = tempfile::tempdir().expect("data dir");
    let runtime = SessionRuntime::at_endpoint(
        unique_endpoint("lifecycle"),
        Some(data.path().to_path_buf()),
    );
    let cwd = std::env::current_dir().expect("cwd");
    let (command, args) = long_lived();

    // First contact starts the broker itself (from the crate-sibling dev binary, copied under the
    // data dir the way an installed app would run it).
    let spawned = runtime
        .spawn(SpawnSessionRequest {
            session_id: "client-lifecycle".into(),
            cwd: Some(cwd.to_string_lossy().into_owned()),
            command,
            args,
            cols: 80,
            rows: 24,
        })
        .expect("spawn through the broker");
    assert!(spawned.running);

    runtime
        .write(WriteSessionRequest {
            session_id: "client-lifecycle".into(),
            run_id: spawned.run_id,
            data: b"echo talkak-client-marker\r\n".to_vec(),
        })
        .expect("write through the broker");

    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let read = runtime
            .read(ReadSessionRequest {
                session_id: "client-lifecycle".into(),
                after: 0,
            })
            .expect("read through the broker");
        if String::from_utf8_lossy(&read.bytes).contains("talkak-client-marker") {
            break;
        }
        assert!(Instant::now() < deadline, "marker never came back");
        std::thread::sleep(Duration::from_millis(50));
    }

    let snapshot = runtime
        .snapshot(SessionIdRequest {
            session_id: "client-lifecycle".into(),
        })
        .expect("snapshot through the broker")
        .expect("session should exist");
    assert!(snapshot.running);
    assert!(snapshot.next > 0, "high-water mark must be populated");

    let stopped = runtime
        .kill(RunSessionRequest {
            session_id: "client-lifecycle".into(),
            run_id: spawned.run_id,
        })
        .expect("kill through the broker");
    assert!(!stopped.running);

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match runtime.discard(SessionIdRequest {
            session_id: "client-lifecycle".into(),
        }) {
            Ok(()) => break,
            // The reader thread may still be draining; discard refuses only running sessions.
            Err(error) if Instant::now() < deadline => {
                assert!(
                    error.to_string().contains("running"),
                    "unexpected discard failure: {error}"
                );
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(error) => panic!("discard never succeeded: {error}"),
        }
    }
    assert!(runtime
        .snapshot(SessionIdRequest {
            session_id: "client-lifecycle".into(),
        })
        .expect("the broker should answer")
        .is_none());
}

/// The pool must default to a SINGLE connection. A broker built before the concurrency fix —
/// including one already running on a machine mid-upgrade — answers one client at a time, so a
/// second connection to it waits forever. Only a handshake that says otherwise may open it up.
#[test]
fn the_pool_holds_to_one_connection_until_a_broker_says_it_serves_concurrently() {
    let runtime = SessionRuntime::at_endpoint(unique_endpoint("limit"), None);
    assert_eq!(runtime.connection_limit(), 1);
}

#[test]
fn talking_to_a_concurrent_broker_opens_the_pool_up() {
    let data = tempfile::tempdir().expect("data dir");
    let runtime = SessionRuntime::at_endpoint(
        unique_endpoint("concurrent"),
        Some(data.path().to_path_buf()),
    );
    runtime
        .live_sessions()
        .expect("the real broker should answer");
    assert!(
        runtime.connection_limit() > 1,
        "a concurrent broker's handshake should raise the limit"
    );
}

#[test]
fn a_second_client_adopts_the_broker_and_finds_the_first_clients_session() {
    let data = tempfile::tempdir().expect("data dir");
    let endpoint = unique_endpoint("adopt");
    let cwd = std::env::current_dir().expect("cwd");
    let (command, args) = long_lived();

    // App process #1.
    let first = SessionRuntime::at_endpoint(endpoint.clone(), Some(data.path().to_path_buf()));
    let spawned = first
        .spawn(SpawnSessionRequest {
            session_id: "adopted".into(),
            cwd: Some(cwd.to_string_lossy().into_owned()),
            command,
            args,
            cols: 80,
            rows: 24,
        })
        .expect("spawn");
    drop(first); // ← the app closing.

    // App process #2 adopts the running broker and re-attaches to the same run.
    let second = SessionRuntime::at_endpoint(endpoint, Some(data.path().to_path_buf()));
    let snapshot = second
        .snapshot(SessionIdRequest {
            session_id: "adopted".into(),
        })
        .expect("snapshot after restart")
        .expect("session must have survived the app restart");
    assert!(snapshot.running);
    assert_eq!(snapshot.run_id, spawned.run_id);

    let stopped = second
        .kill(RunSessionRequest {
            session_id: "adopted".into(),
            run_id: spawned.run_id,
        })
        .expect("cleanup kill");
    assert!(!stopped.running);
}
