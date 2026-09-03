//! One session's output path: the ring the live terminal reads from, the PTY reader thread that
//! fills it, and the back-pressure gate that keeps an attached stream from losing bytes.
//!
//! Ordering on the reader thread is the whole design: the in-memory append and the wake-up come
//! first, the on-disk log after. The log is internal evidence (see `store`), and disk latency must
//! never sit in front of what the terminal shows.

use crate::runtime::RuntimeError;
use crate::store::{now_ms, SessionStore};
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

// Exact internal safety limits, not product promises.
pub const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_READ_BYTES: usize = 64 * 1024;
const CURSOR_POSITION_QUERY: &[u8] = b"\x1b[6n";
const INHERITED_CURSOR_POSITION_REPORT: &[u8] = b"\x1b[1;1R";

/// How long the reader holds one chunk back for the slowest attached stream before giving up on
/// it. Long enough that a busy renderer always catches up; short enough that a client which has
/// stopped reading altogether cannot freeze the shell for everyone else.
pub(crate) const BACKPRESSURE_PATIENCE: Duration = Duration::from_secs(2);

#[derive(Debug, Default)]
pub(crate) struct ProcessStatus {
    pub(crate) running: bool,
    pub(crate) exit_code: Option<u32>,
    pub(crate) read_closed: bool,
    pub(crate) read_error: Option<String>,
}

#[derive(Debug)]
pub struct InitialCursorPositionQuery {
    enabled: bool,
    answered: bool,
    pending: Vec<u8>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct CursorQueryObservation {
    pub output: Vec<u8>,
    pub should_respond: bool,
}

impl InitialCursorPositionQuery {
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled,
            answered: false,
            pending: Vec::new(),
        }
    }

    pub fn observe(&mut self, bytes: &[u8]) -> CursorQueryObservation {
        if !self.enabled || self.answered {
            return CursorQueryObservation {
                output: bytes.to_vec(),
                should_respond: false,
            };
        }

        let mut output = Vec::with_capacity(self.pending.len() + bytes.len());
        for (index, byte) in bytes.iter().enumerate() {
            if *byte == CURSOR_POSITION_QUERY[self.pending.len()] {
                self.pending.push(*byte);
                if self.pending.len() == CURSOR_POSITION_QUERY.len() {
                    self.pending.clear();
                    self.answered = true;
                    output.extend_from_slice(&bytes[index + 1..]);
                    break;
                }
                continue;
            }

            output.append(&mut self.pending);
            if *byte == CURSOR_POSITION_QUERY[0] {
                self.pending.push(*byte);
            } else {
                output.push(*byte);
            }
        }

        CursorQueryObservation {
            output,
            should_respond: self.answered,
        }
    }

    pub fn finish(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.pending)
    }
}

#[derive(Debug, Default)]
pub struct OutputBuffer {
    pub(crate) start: u64,
    pub(crate) next: u64,
    bytes: VecDeque<u8>,
}

#[derive(Debug)]
pub(crate) struct OutputRead {
    pub(crate) start: u64,
    pub(crate) next: u64,
    pub(crate) bytes: Vec<u8>,
    pub(crate) truncated: bool,
}

impl OutputBuffer {
    pub fn append(&mut self, chunk: &[u8]) {
        self.next = self.next.saturating_add(chunk.len() as u64);
        self.bytes.extend(chunk);
        let overflow = self.bytes.len().saturating_sub(MAX_OUTPUT_BYTES);
        if overflow > 0 {
            self.bytes.drain(..overflow);
            self.start = self.start.saturating_add(overflow as u64);
        }
    }

    pub(crate) fn read(&self, after: u64) -> OutputRead {
        let cursor = after.max(self.start).min(self.next);
        let offset = (cursor - self.start) as usize;
        let end = offset.saturating_add(MAX_READ_BYTES).min(self.bytes.len());
        // `range` walks the deque's two slices directly; `iter().skip(offset)` stepped through
        // every byte before the cursor on every read of a full buffer.
        let bytes = self.bytes.range(offset..end).copied().collect::<Vec<_>>();
        OutputRead {
            start: cursor,
            next: cursor.saturating_add(bytes.len() as u64),
            bytes,
            truncated: after < self.start,
        }
    }

    #[cfg(test)]
    pub fn read_for_test(&self, after: u64) -> TestOutputRead {
        let read = self.read(after);
        TestOutputRead {
            start: read.start,
            truncated: read.truncated,
        }
    }
}

#[cfg(test)]
pub struct TestOutputRead {
    pub start: u64,
    pub truncated: bool,
}

/// Real back-pressure for attached streams.
///
/// The ring drops its oldest bytes past `MAX_OUTPUT_BYTES`; the renderer then prints an "older
/// output was omitted" marker and skips the gap — and a dropped range can cut an escape sequence in
/// half and desync a TUI until its next full redraw. Frames are written straight to the socket, so
/// a slow client did hold the *stream* back, but nothing held the *reader thread* back: it kept
/// filling the ring regardless. This gate is that missing link. Every attached stream registers a
/// cursor — the byte it has finished sending — and the reader thread refuses to append a chunk that
/// would evict bytes the slowest live cursor has not read yet, so the kernel PTY buffer fills and
/// the child blocks exactly as it would under a real terminal.
///
/// The ring stays the last resort: with nothing attached the reader never waits, and a stream that
/// sits on one cursor through a whole `patience` is marked stalled and ignored until it moves, so a
/// hung client cannot freeze the shell for the panes that are reading. The `truncated` flag stays
/// honest in both cases.
#[derive(Debug, Default)]
pub struct OutputGate {
    cursors: Mutex<AttachedCursors>,
    consumed: Condvar,
}

#[derive(Debug, Default)]
struct AttachedCursors {
    next_slot: u64,
    slots: HashMap<u64, AttachedCursor>,
}

#[derive(Debug, Clone, Copy)]
struct AttachedCursor {
    cursor: u64,
    stalled: bool,
}

impl OutputGate {
    /// Register a stream; the returned slot starts at byte 0 and is live until `detach`.
    pub fn attach(&self) -> u64 {
        let mut cursors = self.cursors.lock().unwrap_or_else(PoisonError::into_inner);
        let slot = cursors.next_slot;
        cursors.next_slot += 1;
        cursors.slots.insert(
            slot,
            AttachedCursor {
                cursor: 0,
                stalled: false,
            },
        );
        slot
    }

    pub fn detach(&self, slot: u64) {
        let mut cursors = self.cursors.lock().unwrap_or_else(PoisonError::into_inner);
        cursors.slots.remove(&slot);
        drop(cursors);
        self.consumed.notify_all();
    }

    /// The stream has sent everything before `cursor`. Clears a stall: a client that reads again
    /// is a client worth waiting for again.
    pub fn advance(&self, slot: u64, cursor: u64) {
        let mut cursors = self.cursors.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(attached) = cursors.slots.get_mut(&slot) {
            attached.cursor = cursor;
            attached.stalled = false;
        }
        drop(cursors);
        self.consumed.notify_all();
    }

    /// Whether any stream is attached and not stalled.
    pub fn has_live_reader(&self) -> bool {
        let cursors = self.cursors.lock().unwrap_or_else(PoisonError::into_inner);
        cursors.slots.values().any(|attached| !attached.stalled)
    }

    /// Block until appending `chunk_len` bytes to a ring spanning `[start, next)` evicts nothing an
    /// attached stream has not read, or `patience` runs out. Returns `true` when there is room and
    /// `false` when the reader is going ahead anyway — the streams still in the way are marked
    /// stalled so the next chunk does not wait for them too.
    pub fn wait_for_room(
        &self,
        start: u64,
        next: u64,
        chunk_len: usize,
        patience: Duration,
    ) -> bool {
        let deadline = Instant::now() + patience;
        let mut cursors = self.cursors.lock().unwrap_or_else(PoisonError::into_inner);
        loop {
            let Some(slowest) = slowest_live_cursor(&cursors, start) else {
                return true;
            };
            if !would_evict_unread(next, chunk_len, slowest) {
                return true;
            }
            let now = Instant::now();
            if now >= deadline {
                for attached in cursors.slots.values_mut() {
                    if !attached.stalled
                        && would_evict_unread(next, chunk_len, attached.cursor.max(start))
                    {
                        attached.stalled = true;
                    }
                }
                return false;
            }
            cursors = self
                .consumed
                .wait_timeout(cursors, deadline - now)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
    }
}

/// The furthest-behind live cursor, clamped to the ring's start: bytes before `start` are gone
/// already, and waiting cannot bring them back.
fn slowest_live_cursor(cursors: &AttachedCursors, start: u64) -> Option<u64> {
    cursors
        .slots
        .values()
        .filter(|attached| !attached.stalled)
        .map(|attached| attached.cursor.max(start))
        .min()
}

/// Whether appending `chunk_len` bytes to a ring whose high-water mark is `next` moves the ring's
/// start past `cursor` — that is, evicts bytes the reader at `cursor` has not seen.
pub(crate) fn would_evict_unread(next: u64, chunk_len: usize, cursor: u64) -> bool {
    next.saturating_add(chunk_len as u64)
        .saturating_sub(MAX_OUTPUT_BYTES as u64)
        > cursor
}

/// Everything the reader thread shares with the session it feeds.
pub(crate) struct OutputSink {
    pub(crate) output: Arc<Mutex<OutputBuffer>>,
    pub(crate) status: Arc<Mutex<ProcessStatus>>,
    /// Paired with `output`. Signalled after every append and once more when the PTY closes, so a
    /// streaming client sleeps on it instead of polling on a timer.
    pub(crate) changed: Arc<Condvar>,
    pub(crate) gate: Arc<OutputGate>,
    /// Wall-clock milliseconds of the last append; 0 until the PTY has produced anything.
    pub(crate) last_output_ms: Arc<AtomicU64>,
}

pub(crate) fn spawn_reader_thread(
    session_id: String,
    mut reader: Box<dyn Read + Send>,
    sink: OutputSink,
    writer: Arc<Mutex<Option<Box<dyn Write + Send>>>>,
    store: Arc<SessionStore>,
) -> Result<(), RuntimeError> {
    thread::Builder::new()
        .name(format!("talkak-pty-reader-{session_id}"))
        .spawn(move || {
            let mut chunk = [0_u8; 8192];
            // portable-pty requests cursor inheritance from ConPTY. On Windows, answer and
            // remove that one host-level query; later application queries remain for xterm.
            let mut inherited_cursor_query = InitialCursorPositionQuery::new(cfg!(windows));
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(read) => {
                        let observation = inherited_cursor_query.observe(&chunk[..read]);
                        if observation.should_respond {
                            if let Ok(mut current_writer) = writer.lock() {
                                if let Some(current_writer) = current_writer.as_mut() {
                                    let _ = current_writer
                                        .write_all(INHERITED_CURSOR_POSITION_REPORT)
                                        .and_then(|()| current_writer.flush());
                                }
                            }
                        }
                        if !publish(&session_id, &sink, &store, &observation.output) {
                            break;
                        }
                    }
                    Err(error) => {
                        if let Ok(mut current) = sink.status.lock() {
                            if current.running {
                                current.read_error = Some(error.to_string());
                            }
                        }
                        break;
                    }
                }
            }
            let trailing = inherited_cursor_query.finish();
            publish(&session_id, &sink, &store, &trailing);
            if let Ok(mut current) = sink.status.lock() {
                current.read_closed = true;
            }
            // The last wake: whoever is streaming this session gets to send its final frame.
            sink.changed.notify_all();
        })
        .map(|_| ())
        .map_err(|error| RuntimeError::Internal(format!("failed to start PTY reader: {error}")))
}

/// One chunk from the PTY to everyone waiting on it. False when the ring's lock is gone, which
/// ends the reader.
fn publish(session_id: &str, sink: &OutputSink, store: &SessionStore, chunk: &[u8]) -> bool {
    if chunk.is_empty() {
        return true;
    }
    let (start, next) = match sink.output.lock() {
        Ok(buffer) => (buffer.start, buffer.next),
        Err(_) => return false,
    };
    // Held with no lock: an attached stream advances its cursor from its own thread.
    sink.gate
        .wait_for_room(start, next, chunk.len(), BACKPRESSURE_PATIENCE);
    match sink.output.lock() {
        Ok(mut buffer) => buffer.append(chunk),
        Err(_) => return false,
    }
    sink.last_output_ms.store(now_ms(), Ordering::Relaxed);
    sink.changed.notify_all();
    // After the live view, never before it: the log may lag what the terminal already showed,
    // and the store's own writer thread absorbs the disk from here on.
    store.append_output(session_id, chunk);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eviction_is_measured_against_the_readers_cursor() {
        let full = MAX_OUTPUT_BYTES as u64;
        // An empty ring has room for anything.
        assert!(!would_evict_unread(0, 8192, 0));
        // A full ring with the reader at its start: the next chunk would evict unread bytes.
        assert!(would_evict_unread(full, 8192, 0));
        // The same ring with the reader one frame ahead has room for that frame's worth.
        assert!(!would_evict_unread(full, 8192, MAX_READ_BYTES as u64));
        // A reader that has read everything never blocks the writer.
        assert!(!would_evict_unread(full, MAX_OUTPUT_BYTES, full));
    }

    #[test]
    fn with_nothing_attached_the_reader_never_waits() {
        let gate = OutputGate::default();
        let started = Instant::now();
        assert!(gate.wait_for_room(0, MAX_OUTPUT_BYTES as u64, 8192, Duration::from_secs(5)));
        assert!(started.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn an_attached_stream_holds_the_reader_back_until_it_catches_up() {
        let gate = Arc::new(OutputGate::default());
        let slot = gate.attach();
        let full = MAX_OUTPUT_BYTES as u64;
        let producer = {
            let gate = Arc::clone(&gate);
            thread::spawn(move || {
                let started = Instant::now();
                let room = gate.wait_for_room(0, full, 8192, Duration::from_secs(10));
                (room, started.elapsed())
            })
        };
        thread::sleep(Duration::from_millis(150));
        // The stream sends one frame and asks for the next: room for eight chunks opens up.
        gate.advance(slot, MAX_READ_BYTES as u64);
        let (room, waited) = producer.join().expect("producer thread");
        assert!(room, "the reader should have been released by the advance");
        assert!(
            waited >= Duration::from_millis(100),
            "the reader did not wait for the stream: {waited:?}"
        );
        assert!(
            waited < Duration::from_secs(5),
            "the reader waited past the advance"
        );
        gate.detach(slot);
    }

    #[test]
    fn a_stream_that_never_reads_is_given_up_on_and_then_ignored() {
        let gate = OutputGate::default();
        let slot = gate.attach();
        let full = MAX_OUTPUT_BYTES as u64;
        let patience = Duration::from_millis(120);

        let started = Instant::now();
        assert!(!gate.wait_for_room(0, full, 8192, patience));
        let waited = started.elapsed();
        assert!(
            waited >= patience,
            "gave up before its patience ran out: {waited:?}"
        );
        assert!(
            !gate.has_live_reader(),
            "a stream that never moved must be marked stalled"
        );

        // Marked stalled, it no longer holds the next chunk back.
        let started = Instant::now();
        assert!(gate.wait_for_room(0, full + 8192, 8192, patience));
        assert!(started.elapsed() < Duration::from_millis(50));

        // Reading again makes it worth waiting for again.
        gate.advance(slot, full);
        assert!(gate.has_live_reader());
        assert!(!gate.wait_for_room(full - 8192, full * 2, 8192, patience));
        gate.detach(slot);
        assert!(!gate.has_live_reader());
    }

    #[test]
    fn a_cursor_behind_the_ring_start_counts_as_the_start() {
        // Bytes before `start` are already gone; waiting for a stream stuck there is pointless.
        let gate = OutputGate::default();
        let slot = gate.attach();
        let full = MAX_OUTPUT_BYTES as u64;
        let start = full * 3;
        let next = start + full - (MAX_READ_BYTES as u64);
        let started = Instant::now();
        assert!(gate.wait_for_room(start, next, 8192, Duration::from_secs(5)));
        assert!(started.elapsed() < Duration::from_millis(100));
        gate.detach(slot);
    }
}
