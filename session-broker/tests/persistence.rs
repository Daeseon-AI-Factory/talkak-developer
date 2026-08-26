//! Phase 3 verification — the persistence guarantee: a session lives in the broker PROCESS, not in
//! a client connection. When the app disconnects (or closes), the session keeps running; a fresh
//! client reconnects and finds it. This is the tmux-reattach behavior, proven on macOS.
//!
//! Runs the real broker binary (`CARGO_BIN_EXE_*`) over a unix socket, so it exercises the actual
//! server + transport, not just the in-process core.

#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::process::Command;
use std::time::{Duration, Instant};

fn wait_for_socket(path: &str, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if UnixStream::connect(path).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

/// Send one JSON request line and return the first response line.
fn request(path: &str, json: &str) -> String {
    let mut c = UnixStream::connect(path).expect("connect broker");
    c.write_all(json.as_bytes()).unwrap();
    c.write_all(b"\n").unwrap();
    c.flush().unwrap();
    let mut reader = BufReader::new(c.try_clone().unwrap());
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    line
}

#[test]
fn session_survives_client_disconnect() {
    let sock = format!("/tmp/talkak-broker-test-{}.sock", std::process::id());
    let _ = std::fs::remove_file(&sock);

    let bin = env!("CARGO_BIN_EXE_talkak-dev-broker");
    let mut broker = Command::new(bin)
        .arg(&sock)
        .spawn()
        .expect("spawn broker binary");
    assert!(
        wait_for_socket(&sock, Duration::from_secs(5)),
        "broker never bound the socket"
    );

    // Client 1: spawn a long-lived session, read the Spawned reply, then DROP the connection.
    let spawned = request(
        &sock,
        r#"{"method":"spawn","session_id":"p1","program":"bash","args":["-c","sleep 30"],"cols":80,"rows":24}"#,
    );
    assert!(spawned.contains("spawned"), "spawn failed: {spawned}");
    // connection dropped at end of request() — this is "the app closed".

    // Client 2: a brand-new connection must still see the session (it lived in the broker process).
    let listed = request(&sock, r#"{"method":"list"}"#);
    assert!(
        listed.contains("\"p1\"") && listed.contains("\"alive\":true"),
        "session lost after client disconnect: {listed}"
    );

    // Cleanup.
    let _ = request(&sock, r#"{"method":"kill","session_id":"p1"}"#);
    let _ = broker.kill();
    let _ = broker.wait();
    let _ = std::fs::remove_file(&sock);
}
