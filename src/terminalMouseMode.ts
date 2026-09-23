import type { Terminal } from "@xterm/xterm";
import { RESET_INTERACTIVE_INPUT_MODES } from "./terminalInstances";

/**
 * Who owns the mouse in a pane. A full-screen program (vim, htop, an agent's TUI) asks the
 * terminal to report clicks and wheel to it; while it does, selection and native scrolling are
 * gone. "released" means the app turned those reports off on the program's behalf so the mouse is
 * the user's again; the same chord hands it back. Written into xterm's OUTPUT parser only — the
 * PTY never sees these sequences, so the program keeps believing what it asked for.
 */
export type MouseOwner = "none" | "program" | "released";

export type MouseTrackingMode = Terminal["modes"]["mouseTrackingMode"];

/** The DECSET that re-enables the mode a program had, plus SGR encoding (?1006) for wide screens. */
export function mouseTrackingSequence(mode: MouseTrackingMode): string {
  switch (mode) {
    case "x10":
      return "\x1b[?9h";
    case "vt200":
      return "\x1b[?1000h\x1b[?1006h";
    case "drag":
      return "\x1b[?1002h\x1b[?1006h";
    case "any":
      return "\x1b[?1003h\x1b[?1006h";
    default:
      return "";
  }
}

export interface MouseModeHandle {
  readonly owner: MouseOwner;
  /** Program holds the mouse → release it; released → give it back; nothing held → no-op. */
  toggle(): MouseOwner;
  dispose(): void;
}

export interface MouseModeTerminal {
  readonly modes: { readonly mouseTrackingMode: MouseTrackingMode };
  write(data: string): void;
  parser: {
    registerCsiHandler(
      id: { prefix?: string; final: string },
      callback: (params: (number | number[])[]) => boolean,
    ): { dispose(): void };
  };
}

const MOUSE_MODE_PARAMS = new Set([9, 1000, 1002, 1003]);

/**
 * Watches the program's own DECSET/DECRST of the mouse modes so the footer can say who holds
 * the mouse, and keeps the mode a release took away so the toggle can restore it. The handlers
 * return false: xterm still applies the sequence itself.
 */
export function attachMouseMode(
  terminal: MouseModeTerminal,
  onChange: (owner: MouseOwner) => void,
): MouseModeHandle {
  let owner: MouseOwner = terminal.modes.mouseTrackingMode === "none" ? "none" : "program";
  let releasedMode: MouseTrackingMode = "none";
  const set = (next: MouseOwner) => {
    if (owner === next) return;
    owner = next;
    onChange(next);
  };
  const observe = (params: (number | number[])[]) => {
    if (!params.some((param) => typeof param === "number" && MOUSE_MODE_PARAMS.has(param))) {
      return false;
    }
    // The parser applies the mode after this callback; read the result on the next tick.
    queueMicrotask(() => {
      const held = terminal.modes.mouseTrackingMode !== "none";
      if (held) {
        releasedMode = "none";
        set("program");
      } else if (owner === "program") {
        set("none");
      }
    });
    return false;
  };
  const enable = terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, observe);
  const disable = terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, observe);

  return {
    get owner() {
      return owner;
    },
    toggle: () => {
      const held = terminal.modes.mouseTrackingMode;
      if (held !== "none") {
        releasedMode = held;
        terminal.write(RESET_INTERACTIVE_INPUT_MODES);
        set("released");
      } else if (owner === "released" && releasedMode !== "none") {
        terminal.write(mouseTrackingSequence(releasedMode));
        releasedMode = "none";
        set("program");
      }
      return owner;
    },
    dispose: () => {
      enable.dispose();
      disable.dispose();
    },
  };
}

// The shortcut layer addresses panes by session; the mounted pane registers its handle here.
const handles = new Map<string, MouseModeHandle>();

export function registerMouseModeHandle(sessionId: string, handle: MouseModeHandle): () => void {
  handles.set(sessionId, handle);
  return () => {
    if (handles.get(sessionId) === handle) handles.delete(sessionId);
  };
}

/** Toggle mouse ownership on the pane showing `sessionId`; null when no pane is mounted for it. */
export function toggleTerminalMouseMode(sessionId: string): MouseOwner | null {
  const handle = handles.get(sessionId);
  return handle ? handle.toggle() : null;
}
