import { beforeEach, describe, expect, it } from "vitest";
import {
  type TerminalClipboardKeyEvent,
  attachTerminalClipboard,
  pasteTextFor,
  quoteForShell,
  terminalClipboardAction,
} from "./terminalClipboard";

// A real KeyboardEvent carries preventDefault, and the handler calls it on every key it consumes:
// returning false to xterm does not cancel the browser's own handling, so Ctrl+Shift+V — Chromium's
// "paste as plain text" — could otherwise paste twice.
const key = (
  overrides: Partial<TerminalClipboardKeyEvent>,
): TerminalClipboardKeyEvent & { preventDefault: () => void; defaultPrevented: boolean } => {
  const event = {
    type: "keydown",
    code: "",
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    defaultPrevented: false,
    preventDefault: () => {
      event.defaultPrevented = true;
    },
    ...overrides,
  };
  return event;
};

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

  it("consumes plain Ctrl+V before xterm can send Codex a literal ^V", () => {
    expect(terminalClipboardAction(key({ code: "KeyV", ctrlKey: true }), false, "windows")).toBe(
      "paste",
    );
  });

  it("uses ⌘C/⌘V on macOS while Ctrl+C remains a terminal interrupt", () => {
    expect(terminalClipboardAction(key({ code: "KeyC", ctrlKey: true }), true, "macos")).toBe(
      "passthrough",
    );
    expect(terminalClipboardAction(key({ code: "KeyC", metaKey: true }), true, "macos")).toBe(
      "copy",
    );
    expect(terminalClipboardAction(key({ code: "KeyV", metaKey: true }), false, "macos")).toBe(
      "paste",
    );
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
      onSelectionChange: () => ({ dispose: () => {} }),
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

  it("cancels the browser's own handling of a key it consumed, so a paste never doubles", async () => {
    attachTerminalClipboard(terminal("some output"), "windows", {
      writeText: () => Promise.resolve(),
      readText: () => Promise.resolve("x"),
      readImagePath: async () => null,
    });
    // Returning false to xterm does not cancel the browser default by itself. More importantly,
    // letting xterm see plain Ctrl+V sends ^V to Codex, which invokes Codex's image-paste command.
    const paste = key({ code: "KeyV", ctrlKey: true });
    press(paste as unknown as KeyboardEvent);
    expect(paste.defaultPrevented).toBe(true);

    const copy = key({ code: "KeyC", ctrlKey: true });
    press(copy as unknown as KeyboardEvent);
    expect(copy.defaultPrevented).toBe(true);

    // A key this does not consume is left entirely alone.
    const other = key({ code: "KeyA", ctrlKey: true });
    expect(press(other as unknown as KeyboardEvent)).toBe(true);
    expect(other.defaultPrevented).toBe(false);
  });

  it("pastes what the OS clipboard holds", async () => {
    attachTerminalClipboard(terminal(""), "windows", {
      writeText: () => Promise.resolve(),
      readText: () => Promise.resolve("pasted text"),
      readImagePath: async () => null,
    });
    press(key({ code: "KeyV", ctrlKey: true }) as unknown as KeyboardEvent);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pasted).toBe("pasted text");
  });
});

describe("one clipboard gesture produces one terminal paste", () => {
  it("coalesces the key and WebView paste event while the native clipboard read is pending", async () => {
    let press: (event: KeyboardEvent) => boolean = () => true;
    let onPaste: (event: Event) => void = () => {};
    let resolveText: (text: string) => void = () => {};
    let reads = 0;
    const pasted: string[] = [];
    const element = {
      addEventListener: (_type: string, listener: (event: Event) => void) => {
        onPaste = listener;
      },
      removeEventListener: () => {},
    };
    const terminal = {
      element,
      hasSelection: () => false,
      getSelection: () => "",
      clearSelection: () => {},
      paste: (text: string) => pasted.push(text),
      onSelectionChange: () => ({ dispose: () => {} }),
      attachCustomKeyEventHandler: (handler: (event: KeyboardEvent) => boolean) => {
        press = handler;
      },
    } as unknown as Parameters<typeof attachTerminalClipboard>[0];

    attachTerminalClipboard(terminal, "windows", {
      writeText: async () => {},
      readText: () => {
        reads += 1;
        return new Promise<string>((resolve) => {
          resolveText = resolve;
        });
      },
      readImagePath: async () => null,
    });

    press(key({ code: "KeyV", ctrlKey: true }) as unknown as KeyboardEvent);
    onPaste({
      preventDefault: () => {},
      stopImmediatePropagation: () => {},
    } as unknown as Event);
    expect(reads).toBe(1);

    resolveText("once");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pasted).toEqual(["once"]);
  });
});

describe("copy on selection", () => {
  it("copies the settled selection once and disposes the listener with the pane", async () => {
    let selection = "";
    let selectionChanged: () => void = () => {};
    let listenerDisposed = false;
    const copied: string[] = [];
    const terminal = {
      hasSelection: () => selection.length > 0,
      getSelection: () => selection,
      clearSelection: () => {
        selection = "";
      },
      paste: () => {},
      onSelectionChange: (handler: () => void) => {
        selectionChanged = handler;
        return {
          dispose: () => {
            listenerDisposed = true;
          },
        };
      },
      attachCustomKeyEventHandler: () => {},
    } as unknown as Parameters<typeof attachTerminalClipboard>[0];

    const detach = attachTerminalClipboard(terminal, "windows", {
      writeText: async (text) => {
        copied.push(text);
      },
      readText: async () => "",
      readImagePath: async () => null,
    });
    selection = "first drag position";
    selectionChanged();
    selection = "settled selection";
    selectionChanged();

    await new Promise((resolve) => setTimeout(resolve, 140));
    expect(copied).toEqual(["settled selection"]);
    detach();
    expect(listenerDisposed).toBe(true);
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
      onSelectionChange: () => ({ dispose: () => {} }),
      attachCustomKeyEventHandler: (handler: (event: KeyboardEvent) => boolean) => {
        press = handler;
      },
    } as unknown as Parameters<typeof attachTerminalClipboard>[0];
    return {
      terminal,
      pasteResult: () => pasted,
      pressPaste: () => press(key({ code: "KeyV", ctrlKey: true }) as never),
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

describe("the same paste on either platform", () => {
  // The parity requirement in one test: whatever the gesture, a clipboard holding only an image
  // resolves to the same quoted path on Windows and macOS. Image paste used to be Windows-only,
  // because macOS returns passthrough before the paste branch is ever reached.
  const onlyAnImage = {
    writeText: () => Promise.resolve(),
    readText: () => Promise.resolve(""),
    readImagePath: async () => "/tmp/talkak/shot.png",
  };

  it("resolves an image to a quoted path on macOS", async () => {
    expect(await pasteTextFor(onlyAnImage, "macos")).toBe("'/tmp/talkak/shot.png'");
  });

  it("resolves an image to a quoted path on Windows", async () => {
    expect(await pasteTextFor(onlyAnImage, "windows")).toBe('"/tmp/talkak/shot.png"');
  });

  it("prefers text over the image on every platform", async () => {
    const both = {
      writeText: () => Promise.resolve(),
      readText: () => Promise.resolve("real text"),
      readImagePath: async () => "/tmp/talkak/shot.png",
    };
    for (const platform of ["windows", "macos", "other"] as const) {
      expect(await pasteTextFor(both, platform)).toBe("real text");
    }
  });

  it("resolves to nothing when the clipboard holds neither", async () => {
    const empty = {
      writeText: () => Promise.resolve(),
      readText: () => Promise.resolve(""),
      readImagePath: async () => null,
    };
    expect(await pasteTextFor(empty, "windows")).toBe("");
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
