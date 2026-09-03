import type { SessionStreamFrame } from "./sessionFrame";
import { partitionTerminalOutput } from "./terminalReplay";

/**
 * Turns the ordered frames of one output stream into emulator writes and cursor commits.
 *
 * Frames arrive as fast as the PTY produces them; xterm consumes them asynchronously. This keeps
 * them strictly in order — one frame's bytes are fully in the emulator before the next frame's go
 * in — and it never claims a cursor position for bytes the emulator has not taken. Both rules exist
 * because the emulator is RETAINED across page switches: if a write that was already submitted
 * finished after the pane detached, the old poll loop abandoned its cursor advance, re-read the same
 * bytes on the next mount, and painted them twice. Here the cursor moves exactly when xterm reports
 * the bytes are in, whether or not anyone is still watching.
 */

export interface TerminalStreamChunk {
  runId: number;
  /** The engine cursor once these bytes are in the emulator. */
  next: number;
  bytes: Uint8Array;
  /** History being replayed: xterm must not answer its terminal queries into the live shell. */
  suppressProtocolInput: boolean;
}

export interface TerminalStreamSink {
  /**
   * Put the chunk's bytes in the emulator and, once they are, record `next` as the run's cursor.
   * Resolves false when either did not happen — the pane detached first, or the run changed — and
   * the consumer stops there so nothing past the gap is written out of order.
   */
  commit: (chunk: TerminalStreamChunk) => Promise<boolean>;
  /** Shown once when the broker's replay window no longer reaches back to the cursor asked for. */
  truncatedMarker: () => Uint8Array;
  /** Output before this cursor is history; protocol responses to it are suppressed. */
  replayThrough: (frame: SessionStreamFrame) => number;
  /** Called after a frame's bytes are committed, with the status that frame carried. */
  status: (frame: SessionStreamFrame) => void;
}

export interface TerminalStreamConsumer {
  /** Queue a frame behind the ones before it. Resolves when it has been handled or skipped. */
  push: (frame: SessionStreamFrame) => Promise<void>;
  /** Frames not yet started are dropped; a write already handed to xterm still commits. */
  stop: () => void;
}

export function createTerminalStreamConsumer(sink: TerminalStreamSink): TerminalStreamConsumer {
  let stopped = false;
  let tail = Promise.resolve();

  const consume = async (frame: SessionStreamFrame): Promise<void> => {
    if (stopped) return;
    if (frame.truncated) {
      const marked = await sink.commit({
        runId: frame.runId,
        next: frame.start,
        bytes: sink.truncatedMarker(),
        suppressProtocolInput: true,
      });
      if (!marked) return;
    }
    const replayThrough = sink.replayThrough(frame);
    let writtenThrough = frame.start;
    for (const chunk of partitionTerminalOutput(frame.bytes, frame.start, replayThrough)) {
      if (stopped) return;
      writtenThrough += chunk.bytes.length;
      const committed = await sink.commit({
        runId: frame.runId,
        next: writtenThrough,
        bytes: chunk.bytes,
        suppressProtocolInput: chunk.suppressProtocolInput,
      });
      if (!committed) return;
    }
    if (writtenThrough !== frame.next) {
      // A status-only frame, or a cursor the engine moved without bytes (nothing to paint).
      const committed = await sink.commit({
        runId: frame.runId,
        next: frame.next,
        bytes: new Uint8Array(0),
        suppressProtocolInput: false,
      });
      if (!committed) return;
    }
    if (!stopped) sink.status(frame);
  };

  return {
    push: (frame) => {
      const turn = tail.then(() => consume(frame));
      tail = turn.catch(() => undefined);
      return turn;
    },
    stop: () => {
      stopped = true;
    },
  };
}
