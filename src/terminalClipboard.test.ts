import { beforeEach, describe, expect, it } from "vitest";
import {
  type TerminalClipboardKeyEvent,
  attachTerminalClipboard,
  terminalClipboardAction,
} from "./terminalClipboard";

const key = (overrides: Partial<TerminalClipboardKeyEvent>): TerminalClipboardKeyEvent => ({
  type: "keydown",
  code: "",
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...overrides,
});

describe("terminal clipboard keys", () => {
  it("copies on Ctrl+C when text is selected, so copying never doubles as an interrupt", () => {
    expect(terminalClipboardAction(key({ code: "KeyC", ctrlKey: true }), true, "windows")).toBe(
      "copy",
    );
  });

  it("keeps Ctrl+C as the interrupt when nothing is selected", () => {
    expect(terminalClipboardAction(key({ code: "KeyC", ctrlKey: true }), false, "windows")).toBe(
      "passthrough",
    );
  });

  it("always copies on Ctrl+Shift+C and pastes on Ctrl+Shift+V", () => {
    expect(
      terminalClipboardAction(
        key({ code: "KeyC", ctrlKey: true, shiftKey: true }),
        false,
        "windows",
      ),
    ).toBe("copy");
    expect(
      terminalClipboardAction(
        key({ code: "KeyV", ctrlKey: true, shiftKey: true }),
        false,
        "windows",
      ),
    ).toBe("paste");
  });

  it("leaves plain Ctrl+V with the WebView, whose native paste already reaches xterm", () => {
    expect(terminalClipboardAction(key({ code: "KeyV", ctrlKey: true }), false, "windows")).toBe(
      "passthrough",
    );
  });

  it("stays out of macOS entirely — ⌘C is native and Ctrl+C must remain an interrupt", () => {
    expect(terminalClipboardAction(key({ code: "KeyC", ctrlKey: true }), true, "macos")).toBe(
      "passthrough",
    );
    expect(
      terminalClipboardAction(key({ code: "KeyC", ctrlKey: true, shiftKey: true }), true, "macos"),
    ).toBe("passthrough");
  });

  it("acts only on keydown and only without other modifiers", () => {
    expect(
      terminalClipboardAction(key({ type: "keyup", code: "KeyC", ctrlKey: true }), true, "windows"),
    ).toBe("passthrough");
    expect(
      terminalClipboardAction(key({ code: "KeyC", ctrlKey: true, altKey: true }), true, "windows"),
    ).toBe("passthrough");
    expect(
      terminalClipboardAction(key({ code: "KeyC", ctrlKey: true, metaKey: true }), true, "windows"),
    ).toBe("passthrough");
  });
});

describe("clipboard failures are surfaced, never swallowed", () => {
  const terminal = (selection: string) =>
    ({
      hasSelection: () => selection.length > 0,
      getSelection: () => selection,
      clearSelection: () => {
        cleared = true;
      },
      paste: (text: string) => {
        pasted = text;
      },
      attachCustomKeyEventHandler: (handler: (event: KeyboardEvent) => boolean) => {
        press = handler;
      },
    }) as unknown as Parameters<typeof attachTerminalClipboard>[0];

  let press: (event: KeyboardEvent) => boolean;
  let cleared = false;
  let pasted = "";

  beforeEach(() => {
    cleared = false;
    pasted = "";
  });

  it("keeps the selection and reports the reason when a copy is refused", async () => {
    const errors: string[] = [];
    attachTerminalClipboard(
      terminal("some output"),
      "windows",
      {
        writeText: () => Promise.reject(new Error("clipboard unavailable: denied")),
        readText: () => Promise.resolve(""),
        readImagePath: async () => null,
      },
      (message) => errors.push(message),
    );
    press(key({ code: "KeyC", ctrlKey: true }) as unknown as KeyboardEvent);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cleared).toBe(false);
    expect(errors[0]).toContain("copy failed");
    expect(errors[0]).toContain("denied");
  });

  it("clears the selection only once the write actually lands", async () => {
    attachTerminalClipboard(terminal("some output"), "windows", {
      writeText: () => Promise.resolve(),
      readText: () => Promise.resolve(""),
      readImagePath: async () => null,
    });
    press(key({ code: "KeyC", ctrlKey: true }) as unknown as KeyboardEvent);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cleared).toBe(true);
  });

  it("pastes what the OS clipboard holds", async () => {
    attachTerminalClipboard(terminal(""), "windows", {
      writeText: () => Promise.resolve(),
      readText: () => Promise.resolve("pasted text"),
      readImagePath: async () => null,
    });
    press(key({ code: "KeyV", ctrlKey: true, shiftKey: true }) as unknown as KeyboardEvent);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pasted).toBe("pasted text");
  });
});

describe("pasting a screenshot into a terminal", () => {
  it("pastes the image's path, since a PTY cannot carry an image", async () => {
    let pasted = "";
    const terminal = {
      hasSelection: () => false,
      getSelection: () => "",
      clearSelection: () => {},
      paste: (text: string) => {
        pasted = text;
      },
      attachCustomKeyEventHandler: (handler: (event: KeyboardEvent) => boolean) => {
        press = handler;
      },
    } as unknown as Parameters<typeof attachTerminalClipboard>[0];
    let press: (event: KeyboardEvent) => boolean = () => true;

    attachTerminalClipboard(terminal, "windows", {
      writeText: () => Promise.resolve(),
      // Text is present too; the image wins because it is the thing that cannot go through a PTY.
      readText: () => Promise.resolve("some old text"),
      readImagePath: async () => "C:Temp\talkak-clipboardclipboard-1.png",
    });
    press(key({ code: "KeyV", ctrlKey: true, shiftKey: true }) as unknown as KeyboardEvent);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pasted).toBe("C:Temp\talkak-clipboardclipboard-1.png");
  });
});
