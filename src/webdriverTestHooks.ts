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
  /** React commit counts and durations since the hooks were installed (CI Profiler). */
  renderStats: () => {
    commits: number;
    totalMs: number;
    maxMs: number;
    byId: Record<string, number>;
  };
  /** Reset the render counters, e.g. before an idle measurement. */
  resetRenderStats: () => void;
  /** Every retained emulator: which session, whether its element is in the document, run, cursor. */
  retainedTerminalSummary: () => Array<{
    sessionId: string;
    connected: boolean;
    foreground: boolean;
    runId: number | null;
    cursor: number;
    lines: number;
  }>;
  /** Hold one parsed write's completion to reproduce a page switch during an in-flight chunk. */
  holdNextTerminalWrite: (sessionId: string) => void;
  terminalWriteProbe: () => { held: boolean; bytesWritten: number; startCursor: number };
  releaseHeldTerminalWrite: () => void;
  stopTerminalWriteProbe: () => void;
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
    if (element?.isConnected && !element.closest(".background-session-runtime"))
      return entry.terminal;
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

const renderStats = { commits: 0, totalMs: 0, maxMs: 0, byId: {} as Record<string, number> };

/** Fed by the React Profiler main.tsx mounts around the app in the CI build. */
export function recordRender(id: string, actualDurationMs: number): void {
  renderStats.commits += 1;
  renderStats.totalMs += actualDurationMs;
  renderStats.maxMs = Math.max(renderStats.maxMs, actualDurationMs);
  renderStats.byId[id] = (renderStats.byId[id] ?? 0) + 1;
}

export function installWebdriverTestHooks(): void {
  let inputLog: { terminal: Emulator; entries: string[] } | null = null;
  let heldWrite: (() => void) | null = null;
  let restoreWrite: (() => void) | null = null;
  let bytesWritten = 0;
  let startCursor = 0;
  window.__talkakTest = {
    holdNextTerminalWrite: (sessionId) => {
      if (restoreWrite) throw new Error("A terminal write probe is already active");
      const entry = retainedTerminals().get(sessionId);
      if (!entry) throw new Error("No retained terminal for this session");
      const terminal = entry.terminal;
      const original = terminal.write;
      let holdNext = true;
      bytesWritten = 0;
      startCursor = entry.cursor;
      terminal.write = (data, callback) => {
        bytesWritten +=
          typeof data === "string" ? new TextEncoder().encode(data).length : data.length;
        const hold = holdNext;
        holdNext = false;
        original.call(terminal, data, () => {
          if (hold) heldWrite = callback ?? (() => {});
          else callback?.();
        });
      };
      restoreWrite = () => {
        terminal.write = original;
      };
    },
    terminalWriteProbe: () => ({ held: heldWrite !== null, bytesWritten, startCursor }),
    releaseHeldTerminalWrite: () => {
      const complete = heldWrite;
      heldWrite = null;
      complete?.();
    },
    stopTerminalWriteProbe: () => {
      restoreWrite?.();
      restoreWrite = null;
      const complete = heldWrite;
      heldWrite = null;
      complete?.();
    },
    renderStats: () => ({ ...renderStats, byId: { ...renderStats.byId } }),
    resetRenderStats: () => {
      renderStats.commits = 0;
      renderStats.totalMs = 0;
      renderStats.maxMs = 0;
      renderStats.byId = {};
    },
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
        foreground: Boolean(entry.terminal.element?.closest('[data-testid="live-terminal"]')),
        runId: entry.runId,
        cursor: entry.cursor,
        lines: entry.terminal.buffer.active.length,
      })),
  };
}
