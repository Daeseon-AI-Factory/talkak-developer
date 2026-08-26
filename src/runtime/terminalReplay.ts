import type { TerminalRuntimePhase } from "../domain";

export interface TerminalOutputChunk {
  bytes: Uint8Array;
  suppressProtocolInput: boolean;
}

export function terminalPollingEnabled(phase: TerminalRuntimePhase, background: boolean): boolean {
  return phase === "running" || phase === "stopping" || (phase === "exited" && !background);
}

export function terminalRuntimePhase(
  previousPhase: TerminalRuntimePhase,
  running: boolean,
  readError: string | null,
): TerminalRuntimePhase {
  if (readError) return "error";
  if (!running) return "exited";
  return previousPhase === "stopping" ? "stopping" : "running";
}

export function terminalReadShouldContinue(
  running: boolean,
  readClosed: boolean,
  bytesLength: number,
): boolean {
  return running || !readClosed || bytesLength > 0;
}

export function terminalOutputDrained(running: boolean, bytesLength: number): boolean {
  return !running && bytesLength === 0;
}

/** The engine's per-read cap (MAX_READ_BYTES). A read this size means the buffer holds more. */
export const FULL_READ_CHUNK_BYTES = 64 * 1024;

/**
 * How long to wait before the next read. A backlog drains at RPC pace, not poll pace: switching
 * back to a page remounts its terminal and replays the whole buffer, and at one chunk per poll
 * interval a large scrollback was a visible seconds-long crawl from the top. A full chunk — or a
 * finished session with bytes still queued — reads again immediately.
 */
export function nextReadDelayMs(
  running: boolean,
  bytesLength: number,
  pollIntervalMs: number,
): number {
  if (bytesLength >= FULL_READ_CHUNK_BYTES) return 0;
  if (!running && bytesLength > 0) return 0;
  return pollIntervalMs;
}

export function partitionTerminalOutput(
  bytes: Uint8Array,
  start: number,
  replayThrough: number,
): TerminalOutputChunk[] {
  if (bytes.length === 0) return [];
  const replayLength = Math.max(0, Math.min(bytes.length, replayThrough - start));
  if (replayLength === 0) return [{ bytes, suppressProtocolInput: false }];
  if (replayLength === bytes.length) return [{ bytes, suppressProtocolInput: true }];
  return [
    { bytes: bytes.slice(0, replayLength), suppressProtocolInput: true },
    { bytes: bytes.slice(replayLength), suppressProtocolInput: false },
  ];
}
