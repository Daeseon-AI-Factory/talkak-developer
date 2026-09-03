import type { FitAddon } from "@xterm/addon-fit";
import type { ITheme, Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import {
  RESET_INTERACTIVE_INPUT_MODES,
  type RetainedPaneCallbacks,
  applyThemeToRetainedTerminals,
  bindRetainedPane,
  releaseTerminal,
  resetInteractionModes,
  retainTerminal,
  retainedTerminal,
  unbindRetainedPane,
} from "./terminalInstances";

function fakeTerminal() {
  const written: string[] = [];
  const options: { theme?: ITheme; minimumContrastRatio?: number } = {};
  const terminal = {
    options,
    dispose: vi.fn(),
    reset: vi.fn(),
    write: (data: string) => written.push(data),
  } as unknown as Terminal;
  return { terminal, options, written };
}

const callbacks = (): RetainedPaneCallbacks => ({
  onSourceLocation: () => undefined,
  onClipboardNotice: () => undefined,
  onClipboardError: () => undefined,
});

describe("retained pane emulators", () => {
  it("disposes providers registered for the emulator's life together with it", () => {
    const { terminal } = fakeTerminal();
    const provider = { dispose: vi.fn() };
    retainTerminal("s1", {
      terminal,
      fitAddon: {} as FitAddon,
      runId: 1,
      cursor: 0,
      providers: [provider],
      pane: null,
    });
    releaseTerminal("s1");
    expect(provider.dispose).toHaveBeenCalledOnce();
    expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(retainedTerminal("s1")).toBeUndefined();
  });

  it("lets a newer mount keep its callbacks when an older mount unbinds", () => {
    const { terminal } = fakeTerminal();
    retainTerminal("s2", {
      terminal,
      fitAddon: {} as FitAddon,
      runId: null,
      cursor: 0,
      providers: [],
      pane: null,
    });
    const first = callbacks();
    const second = callbacks();
    bindRetainedPane("s2", first);
    bindRetainedPane("s2", second);
    unbindRetainedPane("s2", first);
    expect(retainedTerminal("s2")?.pane).toBe(second);
    unbindRetainedPane("s2", second);
    expect(retainedTerminal("s2")?.pane).toBeNull();
    releaseTerminal("s2");
  });

  it("repaints every retained emulator with the chosen palette", () => {
    const a = fakeTerminal();
    const b = fakeTerminal();
    for (const [id, { terminal }] of [
      ["theme-a", a],
      ["theme-b", b],
    ] as const) {
      retainTerminal(id, {
        terminal,
        fitAddon: {} as FitAddon,
        runId: null,
        cursor: 0,
        providers: [],
        pane: null,
      });
    }
    const theme: ITheme = { background: "#fdf6e3" };
    expect(applyThemeToRetainedTerminals(theme, 3)).toBe(2);
    expect(a.options.theme).toBe(theme);
    expect(b.options.minimumContrastRatio).toBe(3);
    releaseTerminal("theme-a");
    releaseTerminal("theme-b");
  });

  it("resets stale mouse and focus modes in the emulator only", () => {
    const { terminal, written } = fakeTerminal();
    resetInteractionModes(terminal);
    expect(written).toEqual([RESET_INTERACTIVE_INPUT_MODES]);
    expect(RESET_INTERACTIVE_INPUT_MODES).not.toContain("2004");
  });
});
