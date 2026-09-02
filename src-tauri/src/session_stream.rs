//! Push path for terminal output: broker `Output` frames → one binary frame per message on a Tauri
//! channel → xterm.
//!
//! The renderer used to poll `session_read` every 75 ms and receive the bytes as a JSON array of
//! numbers, decoded once by this process and once more by the webview. A keystroke's echo waited
//! out the poll interval; a burst of output crawled in 64 KiB slices, one per poll. Now a pane
//! holds one dedicated broker connection per session, the broker writes a frame the moment the PTY
//! produces output, and the frame reaches the webview as raw bytes behind a fixed 32-byte header —
//! no JSON in the hot path at all.

use crate::session_runtime::SessionRuntime;
use session_broker::runtime::{AttachSessionRequest, SessionRead};
use session_broker::Response;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

/// Wire format of one frame handed to the webview, little-endian:
///
/// | offset | size | field                                              |
/// |--------|------|----------------------------------------------------|
/// | 0      | 1    | version (`FRAME_VERSION`)                          |
/// | 1      | 1    | flags (`FLAG_*`)                                   |
/// | 2      | 8    | run_id                                             |
/// | 10     | 8    | start — engine cursor the payload begins at        |
/// | 18     | 8    | next — engine cursor after the payload             |
/// | 26     | 4    | exit_code (meaningful with `FLAG_HAS_EXIT_CODE`)   |
/// | 30     | 2    | length of the UTF-8 message that follows           |
/// | 32     | n    | message (a read error, or why the stream ended)    |
/// | 32+n   | …    | payload — raw PTY bytes                            |
///
/// `src/runtime/sessionFrame.ts` decodes exactly this; its test and `frame_layout_is_pinned`
/// below share one byte fixture so the two sides cannot drift apart unnoticed.
pub(crate) const FRAME_VERSION: u8 = 1;
pub(crate) const FRAME_HEADER_BYTES: usize = 32;
pub(crate) const FLAG_RUNNING: u8 = 1 << 0;
pub(crate) const FLAG_TRUNCATED: u8 = 1 << 1;
pub(crate) const FLAG_READ_CLOSED: u8 = 1 << 2;
pub(crate) const FLAG_HAS_EXIT_CODE: u8 = 1 << 3;
/// The stream is over; no further frame follows on this channel.
pub(crate) const FLAG_ENDED: u8 = 1 << 4;
/// The message is an error (the broker's read error or a transport failure), not a note.
pub(crate) const FLAG_ERROR: u8 = 1 << 5;

pub(crate) fn encode_frame(
    read: &SessionRead,
    ended: bool,
    transport_error: Option<&str>,
) -> Vec<u8> {
    let mut flags = 0;
    if read.running {
        flags |= FLAG_RUNNING;
    }
    if read.truncated {
        flags |= FLAG_TRUNCATED;
    }
    if read.read_closed {
        flags |= FLAG_READ_CLOSED;
    }
    if read.exit_code.is_some() {
        flags |= FLAG_HAS_EXIT_CODE;
    }
    if ended {
        flags |= FLAG_ENDED;
    }
    let message = transport_error.or(read.read_error.as_deref()).unwrap_or("");
    if !message.is_empty() {
        flags |= FLAG_ERROR;
    }
    let message = truncate_utf8(message, u16::MAX as usize);
    let mut frame = Vec::with_capacity(FRAME_HEADER_BYTES + message.len() + read.bytes.len());
    frame.push(FRAME_VERSION);
    frame.push(flags);
    frame.extend_from_slice(&read.run_id.to_le_bytes());
    frame.extend_from_slice(&read.start.to_le_bytes());
    frame.extend_from_slice(&read.next.to_le_bytes());
    frame.extend_from_slice(&read.exit_code.unwrap_or(0).to_le_bytes());
    frame.extend_from_slice(&(message.len() as u16).to_le_bytes());
    frame.extend_from_slice(message.as_bytes());
    frame.extend_from_slice(&read.bytes);
    frame
}

/// A frame that carries no engine state at all — the stream could not even be opened.
fn failure_frame(message: &str) -> Vec<u8> {
    let empty = SessionRead {
        session_id: String::new(),
        run_id: 0,
        start: 0,
        next: 0,
        bytes: Vec::new(),
        truncated: false,
        running: false,
        exit_code: None,
        read_closed: false,
        read_error: None,
    };
    encode_frame(&empty, true, Some(message))
}

fn truncate_utf8(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// Every open stream, so a pane can close its own when it detaches. Keyed by a per-process id the
/// command hands back; the renderer never sees the connection.
#[derive(Default)]
pub(crate) struct SessionStreams {
    next_id: AtomicU64,
    open: Arc<Mutex<HashMap<u64, Arc<OpenStream>>>>,
}

struct OpenStream {
    cancelled: AtomicBool,
    canceller: Mutex<Option<crate::session_runtime::StreamCanceller>>,
}

/// Start streaming `request.session_id` from byte `request.after` into `on_frame`. Returns a handle
/// for `session_detach`. Frames keep flowing until the session ends, the pane detaches, or the
/// broker goes away; the last frame always carries `FLAG_ENDED`.
#[tauri::command(async)]
pub(crate) fn session_attach(
    runtime: State<'_, SessionRuntime>,
    streams: State<'_, SessionStreams>,
    request: AttachSessionRequest,
    on_frame: Channel<InvokeResponseBody>,
) -> Result<u64, String> {
    let id = streams.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let open = Arc::new(OpenStream {
        cancelled: AtomicBool::new(false),
        canceller: Mutex::new(None),
    });
    let mut stream = match runtime.subscribe(request.clone()) {
        Ok(stream) => stream,
        Err(error) => {
            let _ = on_frame.send(InvokeResponseBody::Raw(failure_frame(&error.to_string())));
            return Err(error.to_string());
        }
    };
    if let Ok(mut slot) = open.canceller.lock() {
        *slot = stream.canceller();
    }
    if let Ok(mut table) = streams.open.lock() {
        table.insert(id, Arc::clone(&open));
    }
    let registry = Arc::clone(&streams.open);
    let worker = std::thread::Builder::new()
        .name(format!("talkak-session-stream-{}", request.session_id))
        .spawn(move || {
            loop {
                if open.cancelled.load(Ordering::SeqCst) {
                    break;
                }
                let (frame, ended) = match stream.next() {
                    Ok(Response::Output(read)) => {
                        let ended = !read.running && read.read_closed && read.bytes.is_empty();
                        (encode_frame(&read, ended, None), ended)
                    }
                    Ok(Response::Error { message }) => (failure_frame(&message), true),
                    Ok(other) => (
                        failure_frame(&format!("unexpected broker frame: {other:?}")),
                        true,
                    ),
                    // The broker closed the stream (session discarded, broker retired) or the
                    // pane cancelled and shut the socket. Either way the channel must end.
                    Err(error) => (
                        failure_frame(&format!("session stream closed: {error}")),
                        true,
                    ),
                };
                if open.cancelled.load(Ordering::SeqCst) {
                    break;
                }
                if on_frame.send(InvokeResponseBody::Raw(frame)).is_err() || ended {
                    break;
                }
            }
            if let Ok(mut table) = registry.lock() {
                table.remove(&id);
            }
        });
    if let Err(error) = worker {
        if let Ok(mut table) = streams.open.lock() {
            table.remove(&id);
        }
        return Err(format!("failed to start the session stream: {error}"));
    }
    Ok(id)
}

/// Stop a stream started by `session_attach`. Idempotent: a stream that already ended is fine.
#[tauri::command(async)]
pub(crate) fn session_detach(streams: State<'_, SessionStreams>, subscription: u64) {
    let open = streams
        .open
        .lock()
        .ok()
        .and_then(|mut table| table.remove(&subscription));
    if let Some(open) = open {
        open.cancelled.store(true, Ordering::SeqCst);
        // Unblocks the worker's read where the transport allows it; elsewhere the broker's
        // one-second keepalive frame is what brings the worker back to see the flag.
        if let Ok(mut slot) = open.canceller.lock() {
            if let Some(canceller) = slot.take() {
                canceller.cancel();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(bytes: &[u8]) -> SessionRead {
        SessionRead {
            session_id: "pane-1".into(),
            run_id: 7,
            start: 1_000,
            next: 1_000 + bytes.len() as u64,
            bytes: bytes.to_vec(),
            truncated: true,
            running: true,
            exit_code: None,
            read_closed: false,
            read_error: None,
        }
    }

    /// The same bytes are asserted by `src/runtime/sessionFrame.test.ts`. Change both or neither.
    #[test]
    fn frame_layout_is_pinned() {
        let frame = encode_frame(&read(b"hi\x1b[0m"), false, None);
        let expected: Vec<u8> = [
            vec![1u8, FLAG_RUNNING | FLAG_TRUNCATED],
            7u64.to_le_bytes().to_vec(),
            1_000u64.to_le_bytes().to_vec(),
            1_006u64.to_le_bytes().to_vec(),
            0u32.to_le_bytes().to_vec(),
            0u16.to_le_bytes().to_vec(),
            b"hi\x1b[0m".to_vec(),
        ]
        .concat();
        assert_eq!(frame, expected);
        assert_eq!(
            frame,
            [
                1, 3, 7, 0, 0, 0, 0, 0, 0, 0, 232, 3, 0, 0, 0, 0, 0, 0, 238, 3, 0, 0, 0, 0, 0, 0,
                0, 0, 0, 0, 0, 0, 104, 105, 27, 91, 48, 109
            ]
        );
    }

    #[test]
    fn an_exit_and_its_error_travel_in_the_header() {
        let mut finished = read(b"");
        finished.running = false;
        finished.read_closed = true;
        finished.exit_code = Some(130);
        finished.read_error = Some("pty gone".into());
        let frame = encode_frame(&finished, true, None);
        assert_eq!(frame[0], FRAME_VERSION);
        assert_eq!(
            frame[1],
            FLAG_TRUNCATED | FLAG_READ_CLOSED | FLAG_HAS_EXIT_CODE | FLAG_ENDED | FLAG_ERROR
        );
        assert_eq!(u32::from_le_bytes(frame[26..30].try_into().unwrap()), 130);
        assert_eq!(u16::from_le_bytes(frame[30..32].try_into().unwrap()), 8);
        assert_eq!(&frame[32..40], b"pty gone");
        assert_eq!(frame.len(), 40);
    }

    #[test]
    fn a_transport_failure_outranks_the_read_error_and_never_splits_a_character() {
        let mut faulted = read(b"");
        faulted.read_error = Some("read".into());
        let frame = encode_frame(&faulted, true, Some("broker gone"));
        assert_eq!(&frame[32..43], b"broker gone");

        let long = "한".repeat(30_000); // 90 000 bytes, past the u16 message field
        let frame = encode_frame(&read(b""), true, Some(&long));
        let length = u16::from_le_bytes(frame[30..32].try_into().unwrap()) as usize;
        assert!(length <= u16::MAX as usize);
        assert!(std::str::from_utf8(&frame[32..32 + length]).is_ok());
    }
}
