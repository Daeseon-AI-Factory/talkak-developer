//! The persistence guarantee on the platform that motivated the port: a session lives in the
//! broker PROCESS, not in a client connection. The unix twin (`persistence.rs`) proves this over a
//! unix socket; this one exercises the real binary over a Windows named pipe, where the child is a
//! ConPTY. A named pipe opens like a file, so the client side stays dependency-free.

#![cfg(windows)]

use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::process::Command;
use std::time::{Duration, Instant};

fn wait_for_pipe(path: &str, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if OpenOptions::new().read(true).write(true).open(path).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

/// Send one JSON request line and return the first response line.
fn request(path: &str, json: &str) -> String {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut client = loop {
        // A momentarily busy pipe (no free instance yet) is retried, not failed.
        match OpenOptions::new().read(true).write(true).open(path) {
            Ok(file) => break file,
            Err(error) => {
                assert!(
                    Instant::now() < deadline,
                    "could not open broker pipe: {error}"
                );
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    };
    client.write_all(json.as_bytes()).unwrap();
    client.write_all(b"\n").unwrap();
    client.flush().unwrap();
    let mut reader = BufReader::new(client.try_clone().unwrap());
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    line
}

#[test]
fn session_survives_client_disconnect() {
    let pipe = format!(r"\\.\pipe\talkak-dev-broker-test-{}", std::process::id());

    let bin = env!("CARGO_BIN_EXE_talkak-dev-broker");
    let mut broker = Command::new(bin)
        .arg(&pipe)
        .spawn()
        .expect("spawn broker binary");
    assert!(
        wait_for_pipe(&pipe, Duration::from_secs(5)),
        "broker never bound the pipe"
    );

    // Client 1: spawn a long-lived ConPTY session, read the Spawned reply, then DROP the
    // connection — this is "the app closed".
    let spawned = request(
        &pipe,
        r#"{"method":"spawn","session_id":"p1","program":"cmd.exe","args":["/D","/S","/C","ping","-n","30","127.0.0.1"],"cols":80,"rows":24}"#,
    );
    assert!(spawned.contains("spawned"), "spawn failed: {spawned}");

    // Client 2: a brand-new connection must still see the session (it lived in the broker process).
    let listed = request(&pipe, r#"{"method":"list"}"#);
    assert!(
        listed.contains("\"p1\"") && listed.contains("\"alive\":true"),
        "session lost after client disconnect: {listed}"
    );

    // Cleanup.
    let _ = request(&pipe, r#"{"method":"kill","session_id":"p1"}"#);
    let _ = broker.kill();
    let _ = broker.wait();
}
