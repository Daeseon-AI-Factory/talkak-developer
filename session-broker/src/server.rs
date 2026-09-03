//! Transport server: newline-delimited JSON in strict request→response lockstep, until a client
//! sends `Attach` — from then on that connection is a one-way stream of `Output` frames.
//!
//! Lockstep connections never read and write at the same time, and a streaming connection is only
//! ever written to by the broker after the one `Attach` line, so the named-pipe hazard the original
//! broker had to design around (a blocking reader starving a concurrent writer on one pipe object)
//! cannot occur on either kind.
//!
//! Exit policy: when a connection closes and no child is running, the broker exits. The app
//! reconnects (or respawns the broker) on its next command, so an empty broker never outlives
//! its usefulness; one with live sessions survives any number of app restarts.

use crate::protocol::{Request, Response, PROTOCOL_VERSION};
use crate::runtime::{AttachSessionRequest, SessionRuntime};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

/// How long a stream waits for output before sending a status-only frame. The keepalive is what
/// lets both sides notice a dead peer: the broker's write fails, and the app's blocking read — with
/// no timeout at all on a Windows pipe — returns so it can check whether it was cancelled.
const STREAM_KEEPALIVE: Duration = Duration::from_secs(1);

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
            concurrent: true,
        },
        Request::Spawn(spawn) => reply(runtime.spawn(spawn), Response::Snapshot),
        Request::Snapshot(id) => reply(runtime.snapshot(id), Response::MaybeSnapshot),
        Request::Read(read) => reply(runtime.read(read), Response::Read),
        // Handled by the connection loop, which owns the write half the stream needs.
        Request::Attach(_) => Response::Error {
            message: "attach is a connection-level request".into(),
        },
        Request::Write(write) => reply(runtime.write(write), |()| Response::Unit),
        Request::Resize(resize) => reply(runtime.resize(resize), |()| Response::Unit),
        Request::Kill(run) => reply(runtime.kill(run), Response::Snapshot),
        Request::Discard(id) => reply(runtime.discard(id), |()| Response::Unit),
        Request::Restorable => Response::Restorable(runtime.restorable()),
        Request::Sessions => Response::Sessions(runtime.live_sessions()),
        Request::StoredOutput(id) => Response::Bytes(runtime.stored_output(&id.session_id)),
        Request::Persists => Response::Persists(runtime.persists()),
        Request::Shutdown => Response::ShuttingDown,
    }
}

async fn serve_connection<S>(
    stream: S,
    runtime: Arc<SessionRuntime>,
    store_dir: Option<String>,
    shutdown_requested: Arc<AtomicBool>,
) where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (read_half, mut write_half) = tokio::io::split(stream);
    let mut lines = BufReader::new(read_half).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Request>(&line) {
            Ok(Request::Attach(attach)) => {
                crate::logging::log(&format!(
                    "attach: {} after {}",
                    attach.session_id, attach.after
                ));
                stream_output(&mut write_half, Arc::clone(&runtime), attach).await;
                // The connection was dedicated to that stream; it ends with it.
                break;
            }
            Ok(request) => {
                if matches!(&request, Request::Shutdown) {
                    shutdown_requested.store(true, Ordering::SeqCst);
                }
                if let Request::Spawn(spawn) = &request {
                    crate::logging::log(&format!("spawn requested: {}", spawn.session_id));
                }
                if let Request::Kill(run) = &request {
                    crate::logging::log(&format!(
                        "kill requested: {} run {}",
                        run.session_id, run.run_id
                    ));
                }
                // Off the async workers. Every heavy arm of dispatch blocks: Spawn does openpty
                // plus CreateProcess, Write blocks in write_all while holding the process writer,
                // Kill waits on the child, StoredOutput reads a whole file. Run inline, one shell
                // that stops draining its input parks a tokio worker for as long as it sulks, and
                // with a worker per core a handful of those starve the runtime — every other
                // pane's reads stop being served. That is the paste that takes ten seconds.
                let runtime = Arc::clone(&runtime);
                let store_dir = store_dir.clone();
                match tokio::task::spawn_blocking(move || {
                    dispatch(request, &runtime, store_dir.as_deref())
                })
                .await
                {
                    Ok(response) => response,
                    // A panicked request must answer the client, or the lockstep protocol
                    // desynchronises and the connection is dead with no one told why.
                    Err(error) => Response::Error {
                        message: format!("request failed: {error}"),
                    },
                }
            }
            Err(error) => Response::Error {
                message: format!("bad request: {error}"),
            },
        };
        if write_frame(&mut write_half, &response).await.is_err() {
            break;
        }
    }
}

async fn write_frame<W: AsyncWrite + Unpin>(
    write_half: &mut W,
    response: &Response,
) -> std::io::Result<()> {
    let mut encoded = serde_json::to_vec(response).unwrap_or_else(|error| {
        // An unencodable reply must surface as an error the client can read, never as a
        // silently dropped connection.
        format!(r#"{{"type":"error","body":{{"message":"unencodable response: {error}"}}}}"#)
            .into_bytes()
    });
    encoded.push(b'\n');
    write_half.write_all(&encoded).await?;
    write_half.flush().await
}

/// Push `Output` frames until the session is exited and drained, it disappears, or the client goes
/// away. Each turn is one `wait_read` on the blocking pool: it returns the moment the PTY produces
/// output, or after the keepalive interval with an empty status frame. Frames are written straight
/// to the connection, so a client that stops reading applies backpressure through the socket, and
/// a client that closed it fails the next write — which is how this loop ends when a pane detaches.
///
/// The stream is *attached* for its whole life: each turn's `after` tells the session's output
/// gate how far this client has got, and the PTY reader thread holds back rather than evict bytes
/// past it. Socket backpressure alone only stalled this loop; the ring kept filling behind it.
async fn stream_output<W: AsyncWrite + Unpin>(
    write_half: &mut W,
    runtime: Arc<SessionRuntime>,
    request: AttachSessionRequest,
) {
    let reader = match runtime.attach(&request.session_id) {
        Ok(reader) => Arc::new(reader),
        Err(error) => {
            let _ = write_frame(
                write_half,
                &Response::Error {
                    message: error.to_string(),
                },
            )
            .await;
            return;
        }
    };
    let mut after = request.after;
    loop {
        let reader = Arc::clone(&reader);
        let outcome =
            tokio::task::spawn_blocking(move || reader.wait_read(after, STREAM_KEEPALIVE)).await;
        let (response, finished) = match outcome {
            Ok(Ok(read)) => {
                after = read.next;
                let finished = !read.running && read.read_closed && read.bytes.is_empty();
                (Response::Output(read), finished)
            }
            Ok(Err(error)) => (
                Response::Error {
                    message: error.to_string(),
                },
                true,
            ),
            Err(error) => (
                Response::Error {
                    message: format!("request failed: {error}"),
                },
                true,
            ),
        };
        if write_frame(write_half, &response).await.is_err() || finished {
            break;
        }
    }
}

#[derive(Clone, Copy)]
struct ClientClosed {
    shutdown_requested: bool,
}

/// Serve a connection on its own task and keep accepting. Awaiting a connection inline meant the
/// broker handled exactly ONE client at a time for that client's whole lifetime: with the app
/// holding a permanent connection, every other connection hung forever, and the app's own panes
/// queued single-file behind each other — the typing lag. The runtime is internally synchronised,
/// so concurrent connections are safe.
fn serve_detached<S>(
    stream: S,
    runtime: Arc<SessionRuntime>,
    store_dir: Option<String>,
    closed_clients: UnboundedSender<ClientClosed>,
) where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let shutdown_requested = Arc::new(AtomicBool::new(false));
    tokio::spawn(async move {
        // The decrement has to survive a panic. As a bare statement after the await it was skipped
        // when a connection task unwound, and since only a transition to zero can retire the
        // broker, one panic left the count permanently above zero: the broker became immortal,
        // holding the endpoint and every session for as long as the machine stayed up.
        let _leaving = ClientGuard {
            shutdown_requested: Arc::clone(&shutdown_requested),
            closed_clients,
        };
        serve_connection(stream, runtime, store_dir, shutdown_requested).await;
    });
}

/// Counts a client out however its task ends — returned, cancelled, or unwound.
struct ClientGuard {
    shutdown_requested: Arc<AtomicBool>,
    closed_clients: UnboundedSender<ClientClosed>,
}

impl Drop for ClientGuard {
    fn drop(&mut self) {
        let _ = self.closed_clients.send(ClientClosed {
            shutdown_requested: self.shutdown_requested.load(Ordering::SeqCst),
        });
    }
}

fn should_stop_server(
    live_clients: &mut usize,
    closed: ClientClosed,
    runtime: &SessionRuntime,
) -> bool {
    if *live_clients == 0 {
        crate::logging::log("ignored an unmatched client-close event");
        return false;
    }
    *live_clients -= 1;
    if closed.shutdown_requested {
        crate::logging::log("exiting: shutdown-requesting client left");
        return true;
    }
    if *live_clients != 0 {
        return false;
    }
    let running = runtime.has_running_sessions();
    crate::logging::log(&format!(
        "last client left: shutdown_requested=false sessions_running={running}"
    ));
    if !running {
        crate::logging::log("exiting: idle");
        return true;
    }
    false
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
    let (closed_clients, mut client_events) = unbounded_channel();
    let mut live_clients = 0;
    loop {
        tokio::select! {
            biased;
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                live_clients += 1;
                serve_detached(
                    stream,
                    Arc::clone(&runtime),
                    store_dir.clone(),
                    closed_clients.clone(),
                );
            }
            Some(closed) = client_events.recv() => {
                if should_stop_server(&mut live_clients, closed, &runtime) {
                    return Ok(());
                }
            }
        }
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
    let (closed_clients, mut client_events) = unbounded_channel();
    let mut live_clients = 0;
    loop {
        tokio::select! {
            biased;
            connected = server.connect() => {
                connected?;
                let connected = server;
                // The next instance exists before this connection is served, so a client arriving
                // mid-conversation is queued by the OS instead of rejected.
                server = ServerOptions::new().create(pipe_name)?;
                live_clients += 1;
                serve_detached(
                    connected,
                    Arc::clone(&runtime),
                    store_dir.clone(),
                    closed_clients.clone(),
                );
            }
            Some(closed) = client_events.recv() => {
                if should_stop_server(&mut live_clients, closed, &runtime) {
                    return Ok(());
                }
            }
        }
    }
}
