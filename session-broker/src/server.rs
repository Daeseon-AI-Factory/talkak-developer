//! Transport server: newline-delimited JSON in strict request→response lockstep.
//!
//! The renderer POLLS `read(after)` — there is no push stream — so every connection is a plain
//! request/response loop and the named-pipe hazard the original broker had to design around
//! (a blocking reader starving a concurrent writer on one pipe object) cannot occur: the client
//! never reads and writes at the same time.
//!
//! Exit policy: when a connection closes and no child is running, the broker exits. The app
//! reconnects (or respawns the broker) on its next command, so an empty broker never outlives
//! its usefulness; one with live sessions survives any number of app restarts.

use crate::protocol::{Request, Response, PROTOCOL_VERSION};
use crate::runtime::SessionRuntime;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};

static SHUTDOWN_REQUESTED: AtomicBool = AtomicBool::new(false);

pub fn dispatch(request: Request, runtime: &SessionRuntime, store_dir: Option<&str>) -> Response {
    fn reply<T>(
        result: Result<T, crate::runtime::RuntimeError>,
        ok: impl FnOnce(T) -> Response,
    ) -> Response {
        match result {
            Ok(value) => ok(value),
            Err(error) => Response::Error {
                message: error.to_string(),
            },
        }
    }

    match request {
        Request::Hello {
            protocol_version: _,
        } => Response::Hello {
            protocol_version: PROTOCOL_VERSION,
            broker_version: env!("CARGO_PKG_VERSION").to_string(),
            pid: std::process::id(),
            store_dir: store_dir.map(str::to_string),
        },
        Request::Spawn(spawn) => reply(runtime.spawn(spawn), Response::Snapshot),
        Request::Snapshot(id) => reply(runtime.snapshot(id), Response::MaybeSnapshot),
        Request::Read(read) => reply(runtime.read(read), Response::Read),
        Request::Write(write) => reply(runtime.write(write), |()| Response::Unit),
        Request::Resize(resize) => reply(runtime.resize(resize), |()| Response::Unit),
        Request::Kill(run) => reply(runtime.kill(run), Response::Snapshot),
        Request::Discard(id) => reply(runtime.discard(id), |()| Response::Unit),
        Request::Restorable => Response::Restorable(runtime.restorable()),
        Request::StoredOutput(id) => Response::Bytes(runtime.stored_output(&id.session_id)),
        Request::Persists => Response::Persists(runtime.persists()),
        Request::Shutdown => {
            SHUTDOWN_REQUESTED.store(true, Ordering::SeqCst);
            Response::ShuttingDown
        }
    }
}

async fn serve_connection<S>(stream: S, runtime: Arc<SessionRuntime>, store_dir: Option<String>)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (read_half, mut write_half) = tokio::io::split(stream);
    let mut lines = BufReader::new(read_half).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Request>(&line) {
            Ok(request) => {
                if let Request::Spawn(spawn) = &request {
                    crate::logging::log(&format!("spawn requested: {}", spawn.session_id));
                }
                if let Request::Kill(run) = &request {
                    crate::logging::log(&format!(
                        "kill requested: {} run {}",
                        run.session_id, run.run_id
                    ));
                }
                dispatch(request, &runtime, store_dir.as_deref())
            }
            Err(error) => Response::Error {
                message: format!("bad request: {error}"),
            },
        };
        let mut encoded = serde_json::to_vec(&response).unwrap_or_else(|error| {
            // An unencodable reply must surface as an error the client can read, never as a
            // silently dropped connection.
            format!(r#"{{"type":"error","body":{{"message":"unencodable response: {error}"}}}}"#)
                .into_bytes()
        });
        encoded.push(b'\n');
        if write_half.write_all(&encoded).await.is_err() {
            break;
        }
        let _ = write_half.flush().await;
    }
}

fn exit_if_idle(runtime: &SessionRuntime) {
    let shutdown = SHUTDOWN_REQUESTED.load(Ordering::SeqCst);
    let running = runtime.has_running_sessions();
    crate::logging::log(&format!(
        "connection closed: shutdown_requested={shutdown} sessions_running={running}"
    ));
    if shutdown || !running {
        crate::logging::log("exiting: idle");
        std::process::exit(0);
    }
}

#[cfg(unix)]
pub async fn serve_unix(
    socket_path: &str,
    runtime: Arc<SessionRuntime>,
    store_dir: Option<String>,
) -> std::io::Result<()> {
    // Refuse to steal a live broker's endpoint: only unlink when nothing answers it.
    if tokio::net::UnixStream::connect(socket_path).await.is_ok() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AddrInUse,
            "another broker is already serving this socket",
        ));
    }
    let _ = std::fs::remove_file(socket_path);
    let listener = tokio::net::UnixListener::bind(socket_path)?;
    loop {
        let (stream, _) = listener.accept().await?;
        serve_connection(stream, Arc::clone(&runtime), store_dir.clone()).await;
        exit_if_idle(&runtime);
    }
}

#[cfg(windows)]
pub async fn serve_pipe(
    pipe_name: &str,
    runtime: Arc<SessionRuntime>,
    store_dir: Option<String>,
) -> std::io::Result<()> {
    use tokio::net::windows::named_pipe::ServerOptions;

    // first_pipe_instance makes the bind race explicit: the second broker process errors out
    // instead of silently splitting the session namespace.
    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .create(pipe_name)?;
    loop {
        server.connect().await?;
        let connected = server;
        // The next instance exists before this connection is served, so a client arriving
        // mid-conversation is queued by the OS instead of rejected.
        server = ServerOptions::new().create(pipe_name)?;
        serve_connection(connected, Arc::clone(&runtime), store_dir.clone()).await;
        exit_if_idle(&runtime);
    }
}
