//! The broker must serve clients CONCURRENTLY. It once awaited each connection inline inside the
//! accept loop, so one client held the broker for its entire lifetime: every other connection hung
//! forever, and the app's own panes queued single-file behind each other — felt as typing lag.

use session_broker::runtime::SessionIdRequest;
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
        format!("/tmp/talkak-dev-concurrency-{}.sock", std::process::id())
    }
    #[cfg(windows)]
    {
        format!(r"\\.\pipe\talkak-dev-concurrency-{}", std::process::id())
    }
}

fn shutdown_endpoint() -> String {
    #[cfg(unix)]
    {
        format!("/tmp/talkak-dev-shutdown-{}.sock", std::process::id())
    }
    #[cfg(windows)]
    {
        format!(r"\\.\pipe\talkak-dev-shutdown-{}", std::process::id())
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

struct Client {
    writer: Conn,
    reader: BufReader<Conn>,
}

impl Client {
    fn connect_within(endpoint: &str, timeout: Duration) -> Self {
        let deadline = Instant::now() + timeout;
        loop {
            if let Ok(conn) = connect(endpoint) {
                let reader = BufReader::new(conn.try_clone().expect("clone"));
                return Self {
                    writer: conn,
                    reader,
                };
            }
            assert!(Instant::now() < deadline, "broker never accepted a client");
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    fn request(&mut self, request: &Request) -> Response {
        let mut line = serde_json::to_vec(request).expect("encode");
        line.push(b'\n');
        self.writer.write_all(&line).expect("send");
        self.writer.flush().expect("flush");
        let mut reply = String::new();
        self.reader.read_line(&mut reply).expect("read");
        serde_json::from_str(&reply).unwrap_or_else(|e| panic!("bad reply {reply:?}: {e}"))
    }

    fn hello(&mut self) {
        match self.request(&Request::Hello {
            protocol_version: PROTOCOL_VERSION,
        }) {
            Response::Hello { .. } => {}
            other => panic!("unexpected hello: {other:?}"),
        }
    }
}

#[test]
fn a_second_client_is_served_while_the_first_holds_its_connection_open() {
    let endpoint = endpoint();
    let bin = env!("CARGO_BIN_EXE_talkak-dev-broker");
    let mut broker = Command::new(bin)
        .arg(&endpoint)
        .spawn()
        .expect("spawn broker");

    // Client A connects and STAYS connected — this is the desktop app.
    let mut app = Client::connect_within(&endpoint, Duration::from_secs(5));
    app.hello();

    // Client B must be served while A's connection is still open. Before the fix this blocked
    // forever; the thread + timeout turns that hang into a failure instead of a hung suite.
    let probe_endpoint = endpoint.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut probe = Client::connect_within(&probe_endpoint, Duration::from_secs(5));
        probe.hello();
        let reply = probe.request(&Request::Snapshot(SessionIdRequest {
            session_id: "nobody".into(),
        }));
        let _ = tx.send(matches!(reply, Response::MaybeSnapshot(None)));
    });

    let served = rx
        .recv_timeout(Duration::from_secs(10))
        .expect("a second client must be served while the first is connected");
    assert!(served, "the concurrent client got the wrong answer");

    // A's connection still works after B came and went.
    app.hello();

    let _ = broker.kill();
    let _ = broker.wait();
}

#[test]
fn shutdown_belongs_to_the_requesting_connection_and_retires_when_it_leaves() {
    let endpoint = shutdown_endpoint();
    let bin = env!("CARGO_BIN_EXE_talkak-dev-broker");
    let mut broker = Command::new(bin)
        .arg(&endpoint)
        .spawn()
        .expect("spawn broker");

    let mut app = Client::connect_within(&endpoint, Duration::from_secs(5));
    app.hello();
    let mut retiring = Client::connect_within(&endpoint, Duration::from_secs(5));
    retiring.hello();
    assert!(matches!(
        retiring.request(&Request::Shutdown),
        Response::ShuttingDown
    ));

    // Merely sending Shutdown does not affect another live client. The requester's close is the
    // boundary promised by the protocol.
    app.hello();
    assert!(
        broker.try_wait().expect("broker status").is_none(),
        "broker retired before the shutdown-requesting connection closed"
    );

    drop(retiring);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match broker.try_wait() {
            Ok(Some(status)) => {
                assert!(status.success(), "graceful shutdown failed: {status}");
                break;
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            Ok(None) => {
                let _ = broker.kill();
                panic!("broker did not retire with the shutdown-requesting client");
            }
            Err(error) => panic!("broker wait failed: {error}"),
        }
    }
    drop(app);
}
