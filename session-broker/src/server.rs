//! macOS/Unix transport: a unix-domain-socket server. Each connection is full-duplex — the client
//! streams requests (spawn/attach/write/resize/kill) in, and the broker streams responses + live
//! session output back. Windows will add a named-pipe transport behind the same request loop.

use crate::broker::Broker;
use crate::protocol::{Request, Response};
use crate::session::SpawnSpec;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

pub const BROKER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// macOS/Unix transport. Serve until cancelled. `socket_path` must not already exist (a stale one
/// is unlinked first). `handle_connection` is transport-agnostic, so Windows reuses it verbatim.
#[cfg(unix)]
pub async fn serve_unix(socket_path: &str, broker: Arc<Broker>) -> std::io::Result<()> {
    let _ = std::fs::remove_file(socket_path); // clear a stale socket from a prior run
    let listener = tokio::net::UnixListener::bind(socket_path)?;
    loop {
        let (stream, _addr) = listener.accept().await?;
        let broker = broker.clone();
        tokio::spawn(async move {
            let _ = handle_connection(stream, broker).await;
        });
    }
}

/// Windows transport — a named pipe. Each accepted client instance is handed to the SAME
/// `handle_connection` (it's generic over `AsyncRead + AsyncWrite`); a fresh server instance is
/// created for the next client. `pipe_name` is like `\\.\pipe\talkak-broker-<user>`.
#[cfg(windows)]
pub async fn serve_pipe(pipe_name: &str, broker: Arc<Broker>) -> std::io::Result<()> {
    use tokio::net::windows::named_pipe::ServerOptions;
    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .create(pipe_name)?;
    loop {
        // Wait for a client to connect to THIS instance.
        server.connect().await?;
        let connected = server;
        // Pre-create the next instance so a new client is never rejected while we handle this one.
        server = ServerOptions::new().create(pipe_name)?;
        let broker = broker.clone();
        tokio::spawn(async move {
            let _ = handle_connection(connected, broker).await;
        });
    }
}

/// One client connection. Reads line-delimited JSON requests; a single writer task serializes all
/// responses (RPC replies + attached output frames) back so writes never interleave.
pub async fn handle_connection<S>(stream: S, broker: Arc<Broker>) -> std::io::Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + 'static,
{
    let (read_half, mut write_half) = tokio::io::split(stream);
    let (to_client, mut from_tasks) = mpsc::channel::<Response>(1024);

    // Single writer: everything the broker sends this client goes through here.
    let writer = tokio::spawn(async move {
        while let Some(resp) = from_tasks.recv().await {
            let mut line = match serde_json::to_string(&resp) {
                Ok(l) => l,
                Err(_) => continue,
            };
            line.push('\n');
            if write_half.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            let _ = write_half.flush().await;
        }
    });

    let mut lines = BufReader::new(read_half).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let req: Request = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                let _ = to_client
                    .send(Response::Error {
                        message: format!("bad request: {e}"),
                    })
                    .await;
                continue;
            }
        };
        dispatch(req, &broker, &to_client).await;
    }

    drop(to_client);
    let _ = writer.await;
    Ok(())
}

async fn dispatch(req: Request, broker: &Arc<Broker>, to_client: &mpsc::Sender<Response>) {
    match req {
        Request::Hello { .. } => {
            let _ = to_client
                .send(Response::Hello {
                    broker_version: BROKER_VERSION.to_string(),
                    pid: std::process::id(),
                })
                .await;
        }
        Request::Spawn {
            session_id,
            program,
            args,
            cwd,
            env,
            cols,
            rows,
        } => {
            let spec = SpawnSpec {
                session_id: session_id.clone(),
                program,
                args,
                cwd,
                env,
                cols,
                rows,
            };
            match broker.spawn(spec) {
                Ok(s) => {
                    let _ = to_client
                        .send(Response::Spawned {
                            session_id,
                            child_pid: s.child_pid,
                        })
                        .await;
                }
                Err(message) => {
                    let _ = to_client.send(Response::Error { message }).await;
                }
            }
        }
        Request::Attach { session_id } => match broker.get(&session_id) {
            Some(session) => {
                let (scrollback, mut rx) = session.attach();
                if !scrollback.is_empty() {
                    let _ = to_client
                        .send(Response::Output {
                            session_id: session_id.clone(),
                            data: scrollback,
                        })
                        .await;
                }
                let to_client = to_client.clone();
                tokio::spawn(async move {
                    loop {
                        match rx.recv().await {
                            Ok(data) => {
                                if to_client
                                    .send(Response::Output {
                                        session_id: session_id.clone(),
                                        data,
                                    })
                                    .await
                                    .is_err()
                                {
                                    break;
                                }
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                            Err(_) => {
                                let _ = to_client
                                    .send(Response::Closed {
                                        session_id: session_id.clone(),
                                    })
                                    .await;
                                break;
                            }
                        }
                    }
                });
            }
            None => {
                let _ = to_client
                    .send(Response::Error {
                        message: format!("no such session: {session_id}"),
                    })
                    .await;
            }
        },
        // Write/Resize are FIRE-AND-FORGET (no reply). This lets the client's write connection be
        // write-only — critical on Windows, where a synchronous named-pipe handle deadlocks if it has
        // a concurrent blocking read (for a reply) + write (2026-07-08 audit 1B). A failed write just
        // means an unresponsive pane, which is self-evident.
        Request::Write { session_id, data } => {
            if let Some(s) = broker.get(&session_id) {
                let _ = s.write(data.as_bytes());
            }
        }
        Request::Resize {
            session_id,
            cols,
            rows,
        } => {
            if let Some(s) = broker.get(&session_id) {
                let _ = s.resize(cols, rows);
            }
        }
        Request::List => {
            let _ = to_client
                .send(Response::List {
                    sessions: broker.list(),
                })
                .await;
        }
        Request::Capture { session_id, lines } => {
            let resp = match broker.get(&session_id) {
                Some(s) => Response::Captured {
                    session_id,
                    text: s.capture(lines),
                },
                None => Response::Error {
                    message: format!("no such session: {session_id}"),
                },
            };
            let _ = to_client.send(resp).await;
        }
        Request::Kill { session_id } => {
            let _ = to_client
                .send(match broker.kill(&session_id) {
                    Ok(()) => Response::Closed { session_id },
                    Err(message) => Response::Error { message },
                })
                .await;
        }
    }
}
