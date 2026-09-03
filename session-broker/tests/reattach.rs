//! The headline guarantee, end to end over the real transport on BOTH platforms: a session spawned
//! by one client keeps running when that client disconnects (the app closing), and a brand-new
//! client — the relaunched app — reattaches to the SAME run, replays the scrollback from byte 0,
//! keeps run_id validation honest, and can keep working in the live PTY.

use session_broker::runtime::{
    ReadSessionRequest, RunSessionRequest, SessionIdRequest, SpawnSessionRequest,
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
        format!("/tmp/talkak-dev-broker-test-{}.sock", std::process::id())
    }
    #[cfg(windows)]
    {
        format!(r"\\.\pipe\talkak-dev-broker-test-{}", std::process::id())
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

/// A client holds ONE connection and speaks strict request→response lockstep, exactly like the app.
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

    fn request(&mut self, request: &Request) -> Response {
        let mut line = serde_json::to_vec(request).expect("encode request");
        line.push(b'\n');
        self.writer.write_all(&line).expect("send request");
        self.writer.flush().expect("flush request");
        let mut reply = String::new();
        self.reader.read_line(&mut reply).expect("read response");
        serde_json::from_str(&reply).unwrap_or_else(|e| panic!("bad response {reply:?}: {e}"))
    }
}

fn long_lived_shell() -> (Option<String>, Vec<String>) {
    #[cfg(unix)]
    {
        (Some("/bin/sh".into()), vec!["-i".into()])
    }
    #[cfg(windows)]
    {
        // The product default (pwsh/powershell) resolves inside the broker itself.
        (None, Vec::new())
    }
}

#[test]
fn a_new_client_reattaches_to_the_run_the_old_client_left_behind() {
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

    // ---- Client A: the first app process. ----
    let mut app_a = Client::new(&endpoint);
    match app_a.request(&Request::Hello {
        protocol_version: PROTOCOL_VERSION,
    }) {
        Response::Hello {
            protocol_version, ..
        } => assert_eq!(protocol_version, PROTOCOL_VERSION),
        other => panic!("unexpected hello reply: {other:?}"),
    }
    let spawned = match app_a.request(&Request::Spawn(SpawnSessionRequest {
        session_id: "reattach".into(),
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
    assert!(spawned.running);
    let run_id = spawned.run_id;

    app_a.request(&Request::Write(WriteSessionRequest {
        session_id: "reattach".into(),
        run_id,
        data: b"echo talkak-broker-marker\r\n".to_vec(),
    }));
    // Wait until the marker echoes back through the PTY.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let read = match app_a.request(&Request::Read(ReadSessionRequest {
            session_id: "reattach".into(),
            after: 0,
        })) {
            Response::Read(read) => read,
            other => panic!("read failed: {other:?}"),
        };
        let text = String::from_utf8_lossy(&read.bytes).into_owned();
        if text.contains("talkak-broker-marker") {
            break;
        }
        assert!(Instant::now() < deadline, "marker never appeared: {text:?}");
        std::thread::sleep(Duration::from_millis(50));
    }
    drop(app_a); // ← the app closing.

    // ---- Client B: the relaunched app. ----
    let mut app_b = Client::new(&endpoint);
    let snapshot = match app_b.request(&Request::Snapshot(SessionIdRequest {
        session_id: "reattach".into(),
    })) {
        Response::MaybeSnapshot(Some(snapshot)) => snapshot,
        other => panic!("session did not survive the disconnect: {other:?}"),
    };
    assert!(snapshot.running, "session should still be running");
    assert_eq!(snapshot.run_id, run_id, "run identity must survive");
    assert!(snapshot.next > 0, "replay high-water mark must be exposed");

    let read = match app_b.request(&Request::Read(ReadSessionRequest {
        session_id: "reattach".into(),
        after: 0,
    })) {
        Response::Read(read) => read,
        other => panic!("replay read failed: {other:?}"),
    };
    assert!(
        String::from_utf8_lossy(&read.bytes).contains("talkak-broker-marker"),
        "scrollback must replay to the new client"
    );

    // The run_id guard still holds across clients: a stale id is refused.
    match app_b.request(&Request::Write(WriteSessionRequest {
        session_id: "reattach".into(),
        run_id: run_id + 1,
        data: b"x".to_vec(),
    })) {
        Response::Error { message } => assert!(
            message.contains("session run changed"),
            "wrong rejection: {message}"
        ),
        other => panic!("stale run_id must be rejected, got {other:?}"),
    }

    // The live PTY still answers the new client — this is work continuing, not a replayed corpse.
    app_b.request(&Request::Write(WriteSessionRequest {
        session_id: "reattach".into(),
        run_id,
        data: b"echo talkak-second-life\r\n".to_vec(),
    }));
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut cursor = 0;
    loop {
        let read = match app_b.request(&Request::Read(ReadSessionRequest {
            session_id: "reattach".into(),
            after: cursor,
        })) {
            Response::Read(read) => read,
            other => panic!("live read failed: {other:?}"),
        };
        cursor = read.next;
        if String::from_utf8_lossy(&read.bytes).contains("talkak-second-life") {
            break;
        }
        assert!(Instant::now() < deadline, "live PTY stopped answering");
        std::thread::sleep(Duration::from_millis(50));
    }

    // Cleanup: kill the session; the broker exits on its own once nothing is running.
    match app_b.request(&Request::Kill(RunSessionRequest {
        session_id: "reattach".into(),
        run_id,
    })) {
        Response::Snapshot(stopped) => assert!(!stopped.running),
        other => panic!("kill failed: {other:?}"),
    }
    drop(app_b);
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
