import { describe, expect, it } from "vitest";
import {
  type ScrollModeHost,
  type ScrollModeTerminal,
  attachScrollMode,
  jumpTerminalToBottom,
  registerScrollModeHandle,
  scrollModeKeyAction,
  toggleTerminalScrollMode,
  watchTerminalViewport,
  wheelScrollLines,
} from "./terminalScrollMode";

const key = (
  key: string,
  modifiers: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {},
) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...modifiers,
});

describe("scroll mode keys", () => {
  it("maps navigation keys and leaves chords to the shortcut layer", () => {
    expect(scrollModeKeyAction(key("ArrowUp"))).toEqual({ kind: "lines", amount: -1 });
    expect(scrollModeKeyAction(key("PageDown"))).toEqual({ kind: "pages", amount: 1 });
    expect(scrollModeKeyAction(key("Home"))).toEqual({ kind: "top" });
    expect(scrollModeKeyAction(key("End"))).toEqual({ kind: "bottom" });
    expect(scrollModeKeyAction(key("Escape"))).toEqual({ kind: "exit" });
    expect(scrollModeKeyAction(key("q"))).toEqual({ kind: "exit" });
    expect(scrollModeKeyAction(key("ArrowUp", { metaKey: true }))).toBeNull();
    expect(scrollModeKeyAction(key("a"))).toBeNull();
  });
});

describe("wheel deltas", () => {
  it("turns pixel, line and page deltas into at least one line", () => {
    expect(wheelScrollLines({ deltaY: 54, deltaMode: 0 }, 24)).toBe(3);
    expect(wheelScrollLines({ deltaY: -3, deltaMode: 0 }, 24)).toBe(-1);
    expect(wheelScrollLines({ deltaY: 2, deltaMode: 1 }, 24)).toBe(2);
    expect(wheelScrollLines({ deltaY: -1, deltaMode: 2 }, 24)).toBe(-24);
    expect(wheelScrollLines({ deltaY: 0, deltaMode: 0 }, 24)).toBe(0);
  });
});

function harness(baseY = 100) {
  const calls: string[] = [];
  const buffer = { active: { viewportY: baseY, baseY } };
  const terminal: ScrollModeTerminal = {
    rows: 24,
    buffer,
    scrollLines: (amount) => {
      calls.push(`lines:${amount}`);
      buffer.active.viewportY = Math.max(0, Math.min(baseY, buffer.active.viewportY + amount));
    },
    scrollPages: (count) => calls.push(`pages:${count}`),
    scrollToTop: () => calls.push("top"),
    scrollToBottom: () => {
      calls.push("bottom");
      buffer.active.viewportY = baseY;
    },
  };
  const listeners = new Map<string, (event: never) => void>();
  const host: ScrollModeHost = {
    addEventListener: (type, listener) => {
      listeners.set(type, listener);
    },
    removeEventListener: (type) => {
      listeners.delete(type);
    },
  };
  const changes: boolean[] = [];
  const handle = attachScrollMode(terminal, host, (active) => changes.push(active));
  const fire = (type: "wheel" | "keydown", event: Record<string, unknown>) => {
    const outcome = { prevented: false, stopped: false };
    listeners.get(type)?.({
      ...event,
      preventDefault: () => {
        outcome.prevented = true;
      },
      stopPropagation: () => {
        outcome.stopped = true;
      },
    } as never);
    return outcome;
  };
  return { terminal, buffer, calls, changes, handle, fire, listeners };
}

describe("scroll mode on a pane", () => {
  it("passes the wheel through until scroll mode is on, then swallows it into the viewport", () => {
    const { handle, fire, calls } = harness();
    expect(fire("wheel", { deltaY: -54, deltaMode: 0 })).toEqual({
      prevented: false,
      stopped: false,
    });
    expect(calls).toEqual([]);

    handle.enter();
    expect(fire("wheel", { deltaY: -54, deltaMode: 0 })).toEqual({
      prevented: true,
      stopped: true,
    });
    expect(calls).toEqual(["lines:-3"]);
  });

  it("leaves scroll mode when the wheel brings the live line back", () => {
    const { handle, fire, changes, buffer } = harness();
    handle.enter();
    fire("wheel", { deltaY: -36, deltaMode: 0 });
    expect(buffer.active.viewportY).toBe(98);
    fire("wheel", { deltaY: 18, deltaMode: 0 });
    expect(handle.active).toBe(true);
    fire("wheel", { deltaY: 18, deltaMode: 0 });
    expect(handle.active).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it("drives the viewport from the keyboard and exits on Escape", () => {
    const { handle, fire, calls } = harness();
    handle.toggle();
    expect(fire("keydown", key("PageUp"))).toEqual({ prevented: true, stopped: true });
    fire("keydown", key("Home"));
    // A key scroll mode does not own goes on to the program untouched.
    expect(fire("keydown", key("a"))).toEqual({ prevented: false, stopped: false });
    fire("keydown", key("Escape"));
    expect(calls).toEqual(["pages:-1", "top"]);
    expect(handle.active).toBe(false);
  });

  it("jumps to the bottom and leaves scroll mode in one gesture", () => {
    const { handle, calls, changes } = harness();
    handle.enter();
    handle.jumpToBottom();
    expect(calls).toEqual(["bottom"]);
    expect(changes).toEqual([true, false]);
  });

  it("removes its listeners on dispose", () => {
    const { handle, listeners } = harness();
    expect(listeners.size).toBe(2);
    handle.dispose();
    expect(listeners.size).toBe(0);
  });
});

describe("the shortcut registry", () => {
  it("reaches the mounted pane by session and reports when none is mounted", () => {
    const { handle } = harness();
    expect(toggleTerminalScrollMode("nobody")).toBe(false);
    const unregister = registerScrollModeHandle("s1", handle);
    expect(toggleTerminalScrollMode("s1")).toBe(true);
    expect(handle.active).toBe(true);
    expect(jumpTerminalToBottom("s1")).toBe(true);
    expect(handle.active).toBe(false);
    unregister();
    expect(toggleTerminalScrollMode("s1")).toBe(false);
  });
});

describe("viewport watching", () => {
  it("reports scrolled-up and mouse-owned only when they change, one read per frame", () => {
    const listeners: Array<() => void> = [];
    const buffer = { active: { viewportY: 100, baseY: 100 } };
    const modes = { mouseTrackingMode: "none" };
    const subscribe = (listener: () => void) => {
      listeners.push(listener);
      return { dispose: () => listeners.splice(listeners.indexOf(listener), 1) };
    };
    const terminal = {
      buffer,
      modes,
      onScroll: subscribe,
      onWriteParsed: subscribe,
      onResize: subscribe,
    } as unknown as Parameters<typeof watchTerminalViewport>[0];
    const frames: Array<() => void> = [];
    const states: Array<{ scrolledUp: boolean; mouseOwned: boolean }> = [];
    const stop = watchTerminalViewport(
      terminal,
      (state) => states.push(state),
      (cb) => frames.push(cb),
    );

    for (const frame of frames.splice(0)) frame();
    expect(states).toEqual([{ scrolledUp: false, mouseOwned: false }]);

    // Three parsed chunks in one frame: one read, and nothing changed, so nothing is reported.
    for (const listener of listeners) listener();
    for (const listener of listeners) listener();
    expect(frames).toHaveLength(1);
    for (const frame of frames.splice(0)) frame();
    expect(states).toHaveLength(1);

    buffer.active.viewportY = 90;
    modes.mouseTrackingMode = "any";
    listeners[0]();
    for (const frame of frames.splice(0)) frame();
    expect(states[1]).toEqual({ scrolledUp: true, mouseOwned: true });

    stop();
    expect(listeners).toHaveLength(0);
  });
});
