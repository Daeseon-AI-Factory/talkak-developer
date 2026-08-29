import { beforeEach, describe, expect, it } from "vitest";
import {
  type TerminalClipboardKeyEvent,
  attachTerminalClipboard,
  quoteForShell,
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
  function pasteHarness() {
    let pasted = "";
    let press: (event: KeyboardEvent) => boolean = () => true;
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
    return {
      terminal,
      pasteResult: () => pasted,
      pressPaste: () => press(key({ code: "KeyV", ctrlKey: true, shiftKey: true }) as never),
    };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("pastes the image's path when the clipboard holds only an image", async () => {
    const harness = pasteHarness();
    attachTerminalClipboard(harness.terminal, "windows", {
      writeText: () => Promise.resolve(),
      readText: () => Promise.resolve(""),
      readImagePath: async () => "C:\\Temp\\talkak-clipboard\\clipboard-1.png",
    });
    harness.pressPaste();
    await settle();
    expect(harness.pasteResult()).toBe('"C:\\Temp\\talkak-clipboard\\clipboard-1.png"');
  });

  it("pastes the text when the clipboard holds both, which is what copying from a browser does", async () => {
    // Windows puts CF_DIB beside the text for rich copies, so asking for the image first answered
    // an ordinary text copy with a PNG path the user never asked for.
    const harness = pasteHarness();
    attachTerminalClipboard(harness.terminal, "windows", {
      writeText: () => Promise.resolve(),
      readText: () => Promise.resolve("SELECT * FROM users"),
      readImagePath: async () => "C:\\Temp\\talkak-clipboard\\clipboard-1.png",
    });
    harness.pressPaste();
    await settle();
    expect(harness.pasteResult()).toBe("SELECT * FROM users");
  });

  it("quotes a path with a space so it reaches the agent as one argument", async () => {
    const harness = pasteHarness();
    attachTerminalClipboard(harness.terminal, "windows", {
      writeText: () => Promise.resolve(),
      readText: () => Promise.resolve(""),
      readImagePath: async () => "C:\\Users\\Daeseon Yoo\\AppData\\Local\\Temp\\shot.png",
    });
    harness.pressPaste();
    await settle();
    // Backslashes stay single: PowerShell's double quotes take them literally, and doubling them
    // the POSIX way would turn every separator into two.
    expect(harness.pasteResult()).toBe('"C:\\Users\\Daeseon Yoo\\AppData\\Local\\Temp\\shot.png"');
  });
});

describe("quoting a path for the shell that will receive it", () => {
  it("wraps a Windows path in double quotes without touching its separators", () => {
    expect(quoteForShell("C:\\Program Files\\a b\\x.png", "windows")).toBe(
      '"C:\\Program Files\\a b\\x.png"',
    );
  });

  it("neutralises a dollar sign, which PowerShell would otherwise expand inside quotes", () => {
    expect(quoteForShell("C:\\tmp\\$env\\x.png", "windows")).toBe('"C:\\tmp\\`$env\\x.png"');
  });

  it("uses single quotes off Windows, where they are literal end to end", () => {
    expect(quoteForShell("/tmp/a b/$HOME`x.png", "other")).toBe("'/tmp/a b/$HOME`x.png'");
  });

  it("closes and reopens the quoting around a single quote, the only thing it cannot hold", () => {
    expect(quoteForShell("/tmp/it's.png", "other")).toBe("'/tmp/it'\\''s.png'");
  });
});
