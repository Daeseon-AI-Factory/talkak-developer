//! The push path over the real transport on BOTH platforms: a client that sends `Attach` on a
//! dedicated connection receives `Output` frames as the PTY produces them — replay first, then live
//! output written on ANOTHER connection, status keepalives while idle, and a final frame followed
//! by the broker closing the stream when the session ends.

use session_broker::runtime::{
    AttachSessionRequest, RunSessionRequest, SessionIdRequest, SpawnSessionRequest,
    WriteSessionRequest,
};
use session_broker::{Request, Response, PROTOCOL_VERSION};
use std::io::{BufRead, BufReader, Write};
use std::process::Command;
use std::time::{Duration, Instant};

#[cfg(unix)]
type Conn = std::os::unix::net::UnixStream;
#[cfg(windows)]
type Conn = std::fs::File;

fn endpoint() -> String {
    #[cfg(unix)]
    {
        format!("/tmp/talkak-dev-attach-{}.sock", std::process::id())
    }
    #[cfg(windows)]
    {
        format!(r"\\.\pipe\talkak-dev-attach-{}", std::process::id())
    }
}

fn connect(endpoint: &str) -> std::io::Result<Conn> {
    #[cfg(unix)]
    {
        Conn::connect(endpoint)
    }
    #[cfg(windows)]
    {
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(endpoint)
    }
}

fn connect_within(endpoint: &str, timeout: Duration) -> Conn {
    let deadline = Instant::now() + timeout;
    loop {
        match connect(endpoint) {
            Ok(conn) => return conn,
            Err(error) => {
                assert!(
                    Instant::now() < deadline,
                    "could not reach broker at {endpoint}: {error}"
                );
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
}

struct Client {
    writer: Conn,
    reader: BufReader<Conn>,
}

impl Client {
    fn new(endpoint: &str) -> Self {
        let conn = connect_within(endpoint, Duration::from_secs(5));
        let reader = BufReader::new(conn.try_clone().expect("clone connection"));
        Self {
            writer: conn,
            reader,
        }
    }

    fn send(&mut self, request: &Request) {
        let mut line = serde_json::to_vec(request).expect("encode request");
        line.push(b'\n');
        self.writer.write_all(&line).expect("send request");
        self.writer.flush().expect("flush request");
    }

    /// One frame, or None when the broker closed the connection.
    fn next(&mut self) -> Option<Response> {
        let mut reply = String::new();
        let read = self.reader.read_line(&mut reply).expect("read frame");
        if read == 0 {
            return None;
        }
        Some(serde_json::from_str(&reply).unwrap_or_else(|e| panic!("bad frame {reply:?}: {e}")))
    }

    fn request(&mut self, request: &Request) -> Response {
        self.send(request);
        self.next().expect("a lockstep reply")
    }
}

fn long_lived_shell() -> (Option<String>, Vec<String>) {
    #[cfg(unix)]
    {
        (Some("/bin/sh".into()), vec!["-i".into()])
    }
    #[cfg(windows)]
    {
        (None, Vec::new())
    }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

#[test]
fn an_attached_connection_receives_output_as_it_happens_and_a_final_frame_at_exit() {
    let endpoint = endpoint();
    let store = tempfile::tempdir().expect("store dir");
    let bin = env!("CARGO_BIN_EXE_talkak-dev-broker");
    let mut broker = Command::new(bin)
        .arg(&endpoint)
        .arg(store.path().as_os_str())
        .spawn()
        .expect("spawn broker binary");

    let (command, args) = long_lived_shell();
    let cwd = std::env::current_dir().expect("cwd");

    // The control connection: lockstep, like every pooled connection in the app.
    let mut control = Client::new(&endpoint);
    match control.request(&Request::Hello {
        protocol_version: PROTOCOL_VERSION,
    }) {
        Response::Hello {
            protocol_version, ..
        } => assert_eq!(protocol_version, PROTOCOL_VERSION),
        other => panic!("unexpected hello reply: {other:?}"),
    }
    let spawned = match control.request(&Request::Spawn(SpawnSessionRequest {
        session_id: "streamed".into(),
        cwd: Some(cwd.to_string_lossy().into_owned()),
        command,
        args,
        env: Vec::new(),
        cols: 80,
        rows: 24,
    })) {
        Response::Snapshot(snapshot) => snapshot,
        other => panic!("spawn failed: {other:?}"),
    };
    let run_id = spawned.run_id;
    control.request(&Request::Write(WriteSessionRequest {
        session_id: "streamed".into(),
        run_id,
        data: b"echo talkak-before-attach\r\n".to_vec(),
    }));

    // The stream connection: one Attach, then read-only.
    let mut stream = Client::new(&endpoint);
    stream.send(&Request::Attach(AttachSessionRequest {
        session_id: "streamed".into(),
        after: 0,
    }));

    // Replay: what was written before the attach arrives first, from byte 0.
    let mut collected = Vec::new();
    let mut cursor = 0;
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut first_start = None;
    while !contains(&collected, b"talkak-before-attach") {
        assert!(
            Instant::now() < deadline,
            "replay never arrived: {collected:?}"
        );
        match stream.next().expect("stream open") {
            Response::Output(read) => {
                assert_eq!(read.run_id, run_id);
                assert_eq!(read.start, cursor, "frames must be contiguous");
                first_start.get_or_insert(read.start);
                cursor = read.next;
                collected.extend(read.bytes);
                assert!(read.running);
            }
            other => panic!("unexpected frame: {other:?}"),
        }
    }
    assert_eq!(first_start, Some(0));

    // Live: output written on the OTHER connection shows up here without any read request, and
    // quickly — well under the old 75 ms poll plus its transfer.
    let written_at = Instant::now();
    control.request(&Request::Write(WriteSessionRequest {
        session_id: "streamed".into(),
        run_id,
        data: b"echo talkak-live-frame\r\n".to_vec(),
    }));
    let deadline = Instant::now() + Duration::from_secs(10);
    while !contains(&collected, b"talkak-live-frame") {
        assert!(Instant::now() < deadline, "live output never arrived");
        match stream.next().expect("stream open") {
            Response::Output(read) => {
                assert_eq!(read.start, cursor);
                cursor = read.next;
                collected.extend(read.bytes);
            }
            other => panic!("unexpected frame: {other:?}"),
        }
    }
    let live_latency = written_at.elapsed();

    // Idle: a status-only keepalive arrives on its own, and the session is still running.
    let keepalive = stream.next().expect("keepalive");
    match keepalive {
        Response::Output(read) => {
            assert!(read.running);
            assert_eq!(read.start, cursor);
        }
        other => panic!("unexpected idle frame: {other:?}"),
    }

    // Exit: kill on the control connection; the stream ends with a final frame and then EOF.
    match control.request(&Request::Kill(RunSessionRequest {
        session_id: "streamed".into(),
        run_id,
    })) {
        Response::Snapshot(stopped) => assert!(!stopped.running),
        other => panic!("kill failed: {other:?}"),
    }
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut saw_final = false;
    loop {
        assert!(Instant::now() < deadline, "the stream never finished");
        match stream.next() {
            Some(Response::Output(read)) => {
                if !read.running && read.read_closed && read.bytes.is_empty() {
                    saw_final = true;
                }
            }
            Some(other) => panic!("unexpected frame after kill: {other:?}"),
            None => break,
        }
    }
    assert!(saw_final, "the last frame must say exited and drained");
    eprintln!("live frame latency: {live_latency:?}");

    // Cleanup and the broker's idle exit.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match control.request(&Request::Discard(SessionIdRequest {
            session_id: "streamed".into(),
        })) {
            Response::Unit => break,
            Response::Error { .. } if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50));
            }
            other => panic!("discard failed: {other:?}"),
        }
    }
    drop(control);
    drop(stream);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match broker.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = broker.kill();
                panic!("broker should exit once idle");
            }
            Err(error) => panic!("broker wait failed: {error}"),
        }
    }
}

/// A pane that detaches simply drops its stream connection. The broker must notice — through the
/// failed keepalive write — and must NOT keep the session's output pinned or the connection counted.
#[test]
fn dropping_the_stream_connection_ends_the_stream_and_the_broker_still_retires() {
    let endpoint = format!("{}-drop", endpoint());
    let store = tempfile::tempdir().expect("store dir");
    let bin = env!("CARGO_BIN_EXE_talkak-dev-broker");
    let mut broker = Command::new(bin)
        .arg(&endpoint)
        .arg(store.path().as_os_str())
        .spawn()
        .expect("spawn broker binary");
    let (command, args) = long_lived_shell();
    let cwd = std::env::current_dir().expect("cwd");

    let mut control = Client::new(&endpoint);
    let spawned = match control.request(&Request::Spawn(SpawnSessionRequest {
        session_id: "dropped".into(),
        cwd: Some(cwd.to_string_lossy().into_owned()),
        command,
        args,
        env: Vec::new(),
        cols: 80,
        rows: 24,
    })) {
        Response::Snapshot(snapshot) => snapshot,
        other => panic!("spawn failed: {other:?}"),
    };

    let mut stream = Client::new(&endpoint);
    stream.send(&Request::Attach(AttachSessionRequest {
        session_id: "dropped".into(),
        after: 0,
    }));
    assert!(matches!(stream.next(), Some(Response::Output(_))));
    drop(stream); // ← the pane detaching.

    match control.request(&Request::Kill(RunSessionRequest {
        session_id: "dropped".into(),
        run_id: spawned.run_id,
    })) {
        Response::Snapshot(stopped) => assert!(!stopped.running),
        other => panic!("kill failed: {other:?}"),
    }
    drop(control);
    // With no client and nothing running the broker exits; a stream task that survived its
    // client would hold the count above zero and keep it alive forever.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match broker.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = broker.kill();
                panic!("broker should exit once its last real client left");
            }
            Err(error) => panic!("broker wait failed: {error}"),
        }
    }
}
