//! Bringing sessions back. A definition whose run was alive when its broker last wrote is
//! restored under the same id with its old output kept and a divider before the new run; one
//! whose run ended — by exit, by a kill — stays ended. Run ids keep climbing across brokers.

use session_broker::runtime::{
    ReadSessionRequest, RunSessionRequest, SessionRuntime, SpawnSessionRequest,
    WriteSessionRequest, RESTORE_DIVIDER,
};
use session_broker::store::SessionStore;
use std::time::{Duration, Instant};

fn spawn_request(session_id: &str, restore: bool) -> SpawnSessionRequest {
    SpawnSessionRequest {
        session_id: session_id.to_owned(),
        cwd: None,
        command: None,
        args: Vec::new(),
        env: Vec::new(),
        cols: 80,
        rows: 24,
        restore,
    }
}

/// Poll the live output until `needle` shows up, so a slow shell start cannot fail the test.
fn wait_for_output(runtime: &SessionRuntime, session_id: &str, needle: &str) -> Vec<u8> {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let read = runtime
            .wait_read(
                ReadSessionRequest {
                    session_id: session_id.to_owned(),
                    after: 0,
                },
                Duration::from_millis(500),
            )
            .expect("read");
        if String::from_utf8_lossy(&read.bytes).contains(needle) {
            return read.bytes;
        }
        assert!(Instant::now() < deadline, "never saw {needle:?}");
    }
}

fn type_line(runtime: &SessionRuntime, session_id: &str, run_id: u64, line: &str) {
    let mut data = line.as_bytes().to_vec();
    data.push(b'\r');
    runtime
        .write(WriteSessionRequest {
            session_id: session_id.to_owned(),
            run_id,
            data,
        })
        .expect("write");
}

#[test]
fn a_live_session_comes_back_with_its_output_and_a_divider_and_an_ended_one_stays_ended() {
    let temp = tempfile::tempdir().unwrap();
    let store_root = temp.path().join("sessions");

    // First broker life: two shells, one of them killed before the "crash".
    let first = SessionRuntime::with_store(SessionStore::at(&store_root));
    let alive = first.spawn(spawn_request("alive", false)).unwrap();
    let ended = first.spawn(spawn_request("ended", false)).unwrap();
    type_line(&first, "alive", alive.run_id, "echo before-restore-marker");
    wait_for_output(&first, "alive", "before-restore-marker");
    first
        .kill(RunSessionRequest {
            session_id: "ended".into(),
            run_id: ended.run_id,
        })
        .unwrap();
    // The exit is observed lazily; a snapshot forces it and stamps the definition.
    let ended_snapshot = first
        .snapshot(session_broker::runtime::SessionIdRequest {
            session_id: "ended".into(),
        })
        .unwrap()
        .unwrap();
    assert!(!ended_snapshot.running);
    let store = SessionStore::at(&store_root);
    let deadline = Instant::now() + Duration::from_secs(5);
    while store.definition("alive").unwrap().ended_at_ms.is_some()
        || store.definition("ended").unwrap().ended_at_ms.is_none()
    {
        assert!(Instant::now() < deadline, "definitions never settled");
        std::thread::sleep(Duration::from_millis(50));
    }
    store.flush("alive");
    let before = store.output("alive");
    assert!(String::from_utf8_lossy(&before).contains("before-restore-marker"));

    // "Crash": the first broker is gone; a second one starts over the same store.
    let highest_run = alive.run_id.max(ended.run_id);
    drop(first);
    let second = SessionRuntime::with_store(SessionStore::at(&store_root));
    let attempted = second.restore_pending(true);
    assert_eq!(
        attempted.len(),
        1,
        "only the session that was alive is attempted: {attempted:?}"
    );
    assert_eq!(attempted[0].0, "alive");
    attempted[0].1.as_ref().expect("restore spawns");
    assert!(
        second.restore_pending(true).is_empty(),
        "a restored session is not restored twice"
    );

    let restored = second
        .snapshot(session_broker::runtime::SessionIdRequest {
            session_id: "alive".into(),
        })
        .unwrap()
        .expect("restored session is live");
    assert!(restored.running);
    assert!(
        restored.run_id > highest_run,
        "run ids keep climbing across brokers"
    );
    let definition = second_definition(&store_root, "alive");
    assert_eq!(definition.restored_run_id, Some(restored.run_id));
    assert!(definition.ended_at_ms.is_none());

    // The live stream replays the old output, then the divider, then the new run.
    let live = wait_for_output(&second, "alive", "session restored");
    let live_text = String::from_utf8_lossy(&live).into_owned();
    let old_at = live_text
        .find("before-restore-marker")
        .expect("old output seeds the live buffer");
    let divider_at = live_text.find("session restored").unwrap();
    assert!(old_at < divider_at, "old output precedes the divider");
    assert!(live
        .windows(RESTORE_DIVIDER.len())
        .any(|window| window == RESTORE_DIVIDER));
    type_line(
        &second,
        "alive",
        restored.run_id,
        "echo after-restore-marker",
    );
    wait_for_output(&second, "alive", "after-restore-marker");
    let store = SessionStore::at(&store_root);
    store.flush("alive");
    let log = String::from_utf8_lossy(&store.output("alive")).into_owned();
    let before_at = log.find("before-restore-marker").expect("old output kept");
    let divider_at = log.find("session restored").expect("divider logged");
    let after_at = log
        .rfind("after-restore-marker")
        .expect("new output logged");
    assert!(before_at < divider_at && divider_at < after_at);

    // The killed session was not brought back and can still be told apart.
    assert!(second
        .snapshot(session_broker::runtime::SessionIdRequest {
            session_id: "ended".into(),
        })
        .unwrap()
        .is_none());
    assert!(second_definition(&store_root, "ended")
        .ended_at_ms
        .is_some());

    let _ = second.kill(RunSessionRequest {
        session_id: "alive".into(),
        run_id: restored.run_id,
    });
}

#[test]
fn sessions_spawned_with_extra_environment_wait_for_the_app() {
    let temp = tempfile::tempdir().unwrap();
    let store_root = temp.path().join("sessions");
    let first = SessionRuntime::with_store(SessionStore::at(&store_root));
    let mut request = spawn_request("with-env", false);
    request.env = vec![("TALKAK_RESTORE_TEST".into(), "1".into())];
    let spawned = first.spawn(request).unwrap();
    assert_eq!(
        second_definition(&store_root, "with-env").env_names,
        vec!["TALKAK_RESTORE_TEST".to_string()],
        "names are stored, never values"
    );
    drop(first);
    let second = SessionRuntime::with_store(SessionStore::at(&store_root));
    assert!(
        second.restore_pending(true).is_empty(),
        "the broker alone leaves it to the app"
    );
    let attempted = second.restore_pending(false);
    assert_eq!(attempted.len(), 1);
    attempted[0]
        .1
        .as_ref()
        .expect("the app-driven restore spawns it");
    let restored = second
        .snapshot(session_broker::runtime::SessionIdRequest {
            session_id: "with-env".into(),
        })
        .unwrap()
        .unwrap();
    assert!(restored.run_id > spawned.run_id);
    let _ = second.kill(RunSessionRequest {
        session_id: "with-env".into(),
        run_id: restored.run_id,
    });
}

fn second_definition(root: &std::path::Path, id: &str) -> session_broker::store::StoredSession {
    SessionStore::at(root)
        .definition(id)
        .expect("definition on disk")
}
