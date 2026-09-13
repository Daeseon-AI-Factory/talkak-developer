import type { Terminal } from "@xterm/xterm";

/**
 * Reading history while a full-screen program owns the mouse.
 *
 * When a program enables mouse tracking, xterm forwards the wheel to it as mouse reports and the
 * pane's own scrollback is unreachable — the program decides what a wheel means, and an agent's
 * TUI usually means nothing. Scroll mode is the pane's answer, in the spirit of tmux copy-mode
 * but inside the emulator: while it is on, wheel and navigation keys move xterm's viewport and are
 * swallowed before xterm can turn them into reports. It works identically on every platform and
 * for every program, because it never touches the PTY.
 */

export type ScrollModeAction =
  | { kind: "lines"; amount: number }
  | { kind: "pages"; amount: number }
  | { kind: "top" }
  | { kind: "bottom" }
  | { kind: "exit" };

export interface ScrollModeKey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/** What a key does in scroll mode, or null for a key scroll mode does not own. */
export function scrollModeKeyAction(event: ScrollModeKey): ScrollModeAction | null {
  // Chords belong to the app's shortcut layer, which runs before this and consumes its own.
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  switch (event.key) {
    case "ArrowUp":
      return { kind: "lines", amount: -1 };
    case "ArrowDown":
      return { kind: "lines", amount: 1 };
    case "PageUp":
      return { kind: "pages", amount: -1 };
    case "PageDown":
      return { kind: "pages", amount: 1 };
    case "Home":
      return { kind: "top" };
    case "End":
      return { kind: "bottom" };
    case "Escape":
    case "q":
      return { kind: "exit" };
    default:
      return null;
  }
}

export interface ScrollModeWheel {
  deltaY: number;
  /** 0 pixels, 1 lines, 2 pages — the DOM's WheelEvent.deltaMode. */
  deltaMode: number;
}

/** Lines to scroll for one wheel event; never zero for a non-zero delta. */
export function wheelScrollLines(event: ScrollModeWheel, rows: number, rowHeightPx = 18): number {
  if (event.deltaY === 0) return 0;
  const lines =
    event.deltaMode === 1
      ? event.deltaY
      : event.deltaMode === 2
        ? event.deltaY * rows
        : event.deltaY / rowHeightPx;
  const rounded = Math.round(lines);
  return rounded === 0 ? Math.sign(event.deltaY) : rounded;
}

/** The slice of an xterm Terminal scroll mode drives; a test hands in a plain object. */
export interface ScrollModeTerminal {
  rows: number;
  scrollLines(amount: number): void;
  scrollPages(count: number): void;
  scrollToTop(): void;
  scrollToBottom(): void;
  buffer: { active: { viewportY: number; baseY: number } };
}

export interface ScrollModeHost {
  addEventListener(
    type: string,
    listener: (event: never) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: (event: never) => void,
    options?: boolean | EventListenerOptions,
  ): void;
}

export interface ScrollModeHandle {
  readonly active: boolean;
  enter: () => void;
  exit: () => void;
  toggle: () => void;
  /** Scroll to the live line and leave scroll mode: what a jump-to-bottom button does. */
  jumpToBottom: () => void;
  dispose: () => void;
}

interface WheelLike extends ScrollModeWheel {
  preventDefault(): void;
  stopPropagation(): void;
}

interface KeyLike extends ScrollModeKey {
  preventDefault(): void;
  stopPropagation(): void;
}

/**
 * Listeners go on the pane host in the CAPTURE phase so they run before xterm's own, and every
 * event scroll mode handles is stopped there — that is what keeps a wheel from reaching a program
 * that asked for mouse reports. Torn down by the pane's disposer: the emulator is retained across
 * mounts and a listener left behind would stack.
 */
export function attachScrollMode(
  terminal: ScrollModeTerminal,
  host: ScrollModeHost,
  onChange: (active: boolean) => void,
): ScrollModeHandle {
  let active = false;
  const set = (next: boolean) => {
    if (active === next) return;
    active = next;
    onChange(next);
  };
  const atBottom = () => terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
  const apply = (action: ScrollModeAction) => {
    switch (action.kind) {
      case "lines":
        terminal.scrollLines(action.amount);
        return;
      case "pages":
        terminal.scrollPages(action.amount);
        return;
      case "top":
        terminal.scrollToTop();
        return;
      case "bottom":
        terminal.scrollToBottom();
        return;
      case "exit":
        set(false);
        return;
    }
  };

  const onWheel = (event: WheelLike) => {
    if (!active) return;
    event.preventDefault();
    event.stopPropagation();
    const lines = wheelScrollLines(event, terminal.rows);
    if (lines !== 0) terminal.scrollLines(lines);
    // Wheeling back down to the live line is the natural way out, as in tmux copy-mode.
    if (lines > 0 && atBottom()) set(false);
  };
  const onKeyDown = (event: KeyLike) => {
    if (!active) return;
    const action = scrollModeKeyAction(event);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    apply(action);
  };

  host.addEventListener("wheel", onWheel, { capture: true, passive: false });
  host.addEventListener("keydown", onKeyDown, true);

  return {
    get active() {
      return active;
    },
    enter: () => set(true),
    exit: () => set(false),
    toggle: () => set(!active),
    jumpToBottom: () => {
      terminal.scrollToBottom();
      set(false);
    },
    dispose: () => {
      host.removeEventListener("wheel", onWheel, { capture: true });
      host.removeEventListener("keydown", onKeyDown, true);
    },
  };
}

// The shortcut layer addresses panes by session; the mounted pane registers its handle here.
const handles = new Map<string, ScrollModeHandle>();

export function registerScrollModeHandle(sessionId: string, handle: ScrollModeHandle): () => void {
  handles.set(sessionId, handle);
  return () => {
    if (handles.get(sessionId) === handle) handles.delete(sessionId);
  };
}

/** Toggle scroll mode on the pane showing `sessionId`; false when no pane is mounted for it. */
export function toggleTerminalScrollMode(sessionId: string): boolean {
  const handle = handles.get(sessionId);
  if (!handle) return false;
  handle.toggle();
  return true;
}

export function jumpTerminalToBottom(sessionId: string): boolean {
  const handle = handles.get(sessionId);
  if (!handle) return false;
  handle.jumpToBottom();
  return true;
}

export interface TerminalViewportState {
  /** The reader is above the live line, so new output is arriving off screen. */
  scrolledUp: boolean;
  /** A program has enabled mouse tracking: the wheel is its, not the pane's. */
  mouseOwned: boolean;
}

type ViewportTerminal = Pick<Terminal, "onScroll" | "onWriteParsed" | "onResize"> & {
  buffer: { active: { viewportY: number; baseY: number } };
  modes: { mouseTrackingMode: string };
};

/**
 * Reports the two facts the pane's overlay is built on, coalesced to one read per frame and only
 * when they change: `onWriteParsed` fires for every chunk an agent streams, and a React state
 * update per chunk would be a render per chunk.
 */
export function watchTerminalViewport(
  terminal: ViewportTerminal,
  listener: (state: TerminalViewportState) => void,
  schedule: (callback: () => void) => void = (callback) => requestAnimationFrame(callback),
): () => void {
  let last: TerminalViewportState | null = null;
  let queued = false;
  let disposed = false;
  const read = () => {
    queued = false;
    if (disposed) return;
    const next: TerminalViewportState = {
      scrolledUp: terminal.buffer.active.viewportY < terminal.buffer.active.baseY,
      mouseOwned: terminal.modes.mouseTrackingMode !== "none",
    };
    if (last && last.scrolledUp === next.scrolledUp && last.mouseOwned === next.mouseOwned) return;
    last = next;
    listener(next);
  };
  const request = () => {
    if (queued) return;
    queued = true;
    schedule(read);
  };
  const subscriptions = [
    terminal.onScroll(request),
    terminal.onWriteParsed(request),
    terminal.onResize(request),
  ];
  request();
  return () => {
    disposed = true;
    for (const subscription of subscriptions) subscription.dispose();
  };
}
