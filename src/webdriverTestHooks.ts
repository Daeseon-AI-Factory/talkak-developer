import { retainedTerminals } from "./terminalInstances";
import { retainedTerminalLogs } from "./terminalLogInstances";

/**
 * Test-only window hooks for the WebDriver product gates. Compiled ONLY in the `webdriver-ci` Vite
 * mode; `scripts/check-webdriver-bundle.mjs` asserts the `__talkakTest` marker is absent from a
 * product bundle.
 *
 * The gates used to read terminal text out of `.xterm-rows`. That is the DOM renderer's private
 * layout — one WebDriver round-trip per row, and nothing at all under a canvas renderer. xterm's
 * buffer API is what the emulator actually holds, whichever renderer paints it — so the tests read
 * that, in one call.
 */
export interface TalkakTestHooks {
  /** The mounted live terminal's whole buffer, one string per line, trailing blanks trimmed. */
  liveTerminalLines: () => string[];
  /** The mounted live terminal's current selection. */
  liveTerminalSelection: () => string;
  /** Cell geometry of the mounted live terminal, for pointer-driven tests. */
  liveTerminalGeometry: () => TerminalGeometry | null;
  /** The mounted terminal-log inspector's whole buffer. */
  terminalLogLines: () => string[];
  /** Start recording what the mounted live terminal emits as input; returns the log so far. */
  liveTerminalInputLog: () => string[];
  /** Every retained emulator: which session, whether its element is in the document, run, cursor. */
  retainedTerminalSummary: () => Array<{
    sessionId: string;
    connected: boolean;
    runId: number | null;
    cursor: number;
    lines: number;
  }>;
}

export interface TerminalGeometry {
  cols: number;
  rows: number;
  /** Absolute line index of the first viewport row. */
  viewportY: number;
  cellWidth: number;
  cellHeight: number;
  screenLeft: number;
  screenTop: number;
}

declare global {
  interface Window {
    __talkakTest?: TalkakTestHooks;
  }
}

type Emulator = import("@xterm/xterm").Terminal;

function mounted<T extends { terminal: Emulator }>(
  entries: ReadonlyMap<string, T>,
): Emulator | null {
  for (const entry of entries.values()) {
    const element = entry.terminal.element;
    if (element?.isConnected) return entry.terminal;
  }
  return null;
}

function bufferLines(terminal: Emulator | null): string[] {
  if (!terminal) return [];
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  }
  return lines;
}

export function installWebdriverTestHooks(): void {
  let inputLog: { terminal: Emulator; entries: string[] } | null = null;
  window.__talkakTest = {
    liveTerminalInputLog: () => {
      const terminal = mounted(retainedTerminals());
      if (!terminal) return [];
      if (inputLog?.terminal !== terminal) {
        inputLog = { terminal, entries: [] };
        const entries = inputLog.entries;
        terminal.onData((data) => entries.push(data));
      }
      return [...inputLog.entries];
    },
    liveTerminalLines: () => bufferLines(mounted(retainedTerminals())),
    liveTerminalSelection: () => mounted(retainedTerminals())?.getSelection() ?? "",
    liveTerminalGeometry: () => {
      const terminal = mounted(retainedTerminals());
      const screen = terminal?.element?.querySelector(".xterm-screen");
      if (!terminal || !screen) return null;
      const rect = screen.getBoundingClientRect();
      return {
        cols: terminal.cols,
        rows: terminal.rows,
        viewportY: terminal.buffer.active.viewportY,
        cellWidth: rect.width / terminal.cols,
        cellHeight: rect.height / terminal.rows,
        screenLeft: rect.left,
        screenTop: rect.top,
      };
    },
    terminalLogLines: () => bufferLines(mounted(retainedTerminalLogs())),
    retainedTerminalSummary: () =>
      [...retainedTerminals().entries()].map(([sessionId, entry]) => ({
        sessionId,
        connected: entry.terminal.element?.isConnected ?? false,
        runId: entry.runId,
        cursor: entry.cursor,
        lines: entry.terminal.buffer.active.length,
      })),
  };
}
