import type { FitAddon } from "@xterm/addon-fit";
import type { IDisposable, ITheme, Terminal } from "@xterm/xterm";
import type { SourceLocation } from "./sourceLocations";
import type { TerminalClipboardNotice } from "./terminalClipboard";

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

/**
 * What the mounted pane does when the emulator reports something — a clicked file:line, a copy
 * that landed. Set on mount and cleared on detach, so a provider registered once for the life of
 * the emulator never calls into a component that has since unmounted.
 */
export interface RetainedPaneCallbacks {
  onSourceLocation: (location: SourceLocation, text: string) => void;
  onClipboardNotice: (notice: TerminalClipboardNotice) => void;
  onClipboardError: (message: string) => void;
}

export interface RetainedTerminal {
  terminal: Terminal;
  fitAddon: FitAddon;
  /** The run this buffer belongs to; a different run must not inherit another run's screen. */
  runId: number | null;
  /** Next engine byte to read; the pane resumes here instead of replaying from zero. */
  cursor: number;
  /** Registered once per emulator (link providers); disposed with it, never per mount. */
  providers: IDisposable[];
  pane: RetainedPaneCallbacks | null;
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

export function bindRetainedPane(sessionId: string, pane: RetainedPaneCallbacks): void {
  const entry = retained.get(sessionId);
  if (entry) entry.pane = pane;
}

/** Clears the callbacks only when they are still the ones given, so a newer mount keeps its own. */
export function unbindRetainedPane(sessionId: string, pane: RetainedPaneCallbacks): void {
  const entry = retained.get(sessionId);
  if (entry && entry.pane === pane) entry.pane = null;
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
  for (const provider of entry.providers) provider.dispose();
  entry.pane = null;
  entry.terminal.dispose();
}

/** Repaint every retained emulator with a new palette; returns how many were touched. */
export function applyThemeToRetainedTerminals(theme: ITheme, minimumContrastRatio: number): number {
  for (const entry of retained.values()) {
    entry.terminal.options.theme = theme;
    entry.terminal.options.minimumContrastRatio = minimumContrastRatio;
  }
  return retained.size;
}

/**
 * A full-screen program can exit without restoring the DEC private modes it enabled. If xterm
 * still believes mouse tracking is on after the program is gone, every click becomes an SGR
 * report such as `\x1b[<35;77;4M` typed into whatever reads the PTY next, and a shell executes the
 * visible tail. This sequence is written into xterm's OUTPUT parser — never to the PTY — so the
 * emulator stops generating those reports. Focus reporting is another program-owned mode that
 * must not outlive its program. Bracketed paste (?2004) is deliberately left alone: the shell's
 * own prompt setup owns it.
 */
export const RESET_INTERACTIVE_INPUT_MODES =
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1006l";

export function resetInteractionModes(terminal: Pick<Terminal, "write">): void {
  terminal.write(RESET_INTERACTIVE_INPUT_MODES);
}
