import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

/**
 * Terminals outlive their pane components. Switching pages unmounts a pane; recreating xterm
 * there meant replaying the whole output buffer from byte zero — a visible top-to-bottom crawl on
 * every switch, which the original product never had because its terminal registry kept instances
 * alive and only moved DOM. This is that layer: the emulator, its parsed buffer and its read
 * cursor survive the component, so a returning pane appends only what happened while it was away.
 *
 * Entries are per session and live until the session starts a NEW run (the buffer belongs to the
 * old one) — a handful of retained emulators with capped scrollback, bounded by session count.
 */

interface RetainedTerminal {
  terminal: Terminal;
  fitAddon: FitAddon;
  /** The run this buffer belongs to; a different run must not inherit another run's screen. */
  runId: number | null;
  /** Next engine byte to read; the pane resumes here instead of replaying from zero. */
  cursor: number;
}

const retained = new Map<string, RetainedTerminal>();

export function retainedTerminal(sessionId: string): RetainedTerminal | undefined {
  return retained.get(sessionId);
}

/** Every retained emulator, for the CI test hooks that read terminal text through xterm's buffer. */
export function retainedTerminals(): ReadonlyMap<string, RetainedTerminal> {
  return retained;
}

export function retainTerminal(sessionId: string, entry: RetainedTerminal): void {
  retained.set(sessionId, entry);
}

/**
 * Record how far into `runId`'s output the retained emulator has been painted. A cursor from
 * another run is ignored: a write that was already in flight when the session restarted lands in
 * an emulator that has since been reset for the new run, and must not move the new run's cursor.
 */
export function updateRetainedCursor(sessionId: string, runId: number, cursor: number): void {
  const entry = retained.get(sessionId);
  if (!entry) return;
  if (entry.runId !== null && entry.runId !== runId) return;
  entry.runId = runId;
  entry.cursor = cursor;
}

/** A fresh run gets a fresh screen: clear the emulator and rewind the cursor. */
export function resetRetainedRun(sessionId: string, runId: number): void {
  const entry = retained.get(sessionId);
  if (!entry) return;
  entry.terminal.reset();
  entry.runId = runId;
  entry.cursor = 0;
}

export function releaseTerminal(sessionId: string): void {
  const entry = retained.get(sessionId);
  if (!entry) return;
  retained.delete(sessionId);
  entry.terminal.dispose();
}
