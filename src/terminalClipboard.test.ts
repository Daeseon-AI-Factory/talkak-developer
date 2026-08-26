import { describe, expect, it } from "vitest";
import { type TerminalClipboardKeyEvent, terminalClipboardAction } from "./terminalClipboard";

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
