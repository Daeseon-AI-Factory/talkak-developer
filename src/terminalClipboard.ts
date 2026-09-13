import type { IClipboardProvider } from "@xterm/addon-clipboard";
import type { Terminal } from "@xterm/xterm";
import type { DesktopPlatform } from "./platform";
import { type ClipboardClient, clipboardClient } from "./runtime/clipboardClient";

/**
 * Clipboard keys for a terminal pane. The app owns the platform paste chord so xterm cannot also
 * send it to the PTY as a control character: Ctrl+V is ^V, which Codex treats as its own image
 * command. Windows uses Ctrl+C/Ctrl+V and macOS uses ⌘C/⌘V; Ctrl+C on macOS still reaches the
 * terminal as an interrupt.
 */

export type TerminalClipboardAction = "copy" | "paste" | "passthrough";

/** Something the clipboard did that deserves a moment of feedback. */
export type TerminalClipboardNotice =
  | { kind: "copied"; text: string }
  | { kind: "imagePathPasted"; path: string };

/**
 * A pasted image path lands on a shell command line, where a space separates arguments. The temp
 * directory descends from the Windows profile folder, which is named after the account's display
 * name — `C:\Users\Daeseon Yoo\AppData\Local\Temp\...` is the ordinary case, not the odd one, and
 * unquoted it reaches the agent as two arguments and opens nothing.
 *
 * Each shell's literal form differs, so this cannot be one rule. Inside PowerShell's double quotes
 * a backslash is an ordinary character and the escape is a backtick, so escaping `\` the POSIX way
 * would turn every separator in the path into two. POSIX single quotes take everything literally,
 * which is what a generated path wants.
 */
export function quoteForShell(path: string, platform: DesktopPlatform): string {
  if (platform === "windows") {
    // A Windows path cannot contain " or `, so quoting is all that is needed. $ is inert inside
    // cmd's quotes and expands in PowerShell's, so it is neutralised with PowerShell's own escape.
    return `"${path.replace(/[$`]/g, "`$&")}"`;
  }
  // POSIX: single quotes are literal end to end; the only thing they cannot hold is a single quote.
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

export interface TerminalClipboardKeyEvent {
  type: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export function terminalClipboardAction(
  event: TerminalClipboardKeyEvent,
  hasSelection: boolean,
  platform: DesktopPlatform,
): TerminalClipboardAction {
  if (event.type !== "keydown") return "passthrough";
  const primaryModifier = platform === "macos" ? event.metaKey : event.ctrlKey;
  const wrongModifier = platform === "macos" ? event.ctrlKey : event.metaKey;
  if (!primaryModifier || wrongModifier || event.altKey) return "passthrough";
  if (event.code === "KeyC" && (hasSelection || (platform !== "macos" && event.shiftKey))) {
    return "copy";
  }
  if (event.code === "KeyV") return "paste";
  return "passthrough";
}

// Box drawing and block elements, U+2500–U+259F: frames, dividers, banners, progress bars.
const BOX_GLYPHS = /[\u2500-\u259F]/g;

/**
 * The text a selection puts on the clipboard. xterm hands back raw grid cells, and an agent's
 * framed output is the thing most often copied from these panes: every line then carries a frame
 * glyph at each edge and cell padding to the frame. Frames, dividers and banners are decoration,
 * never content, so every box glyph goes, trailing padding is trimmed per line, and the blank runs
 * that divider rows leave collapse. A selection that was nothing but decoration returns "" — the
 * caller copies nothing rather than a run of newlines. The on-screen selection is untouched.
 *
 * Trade-off, accepted: a table's borders are dropped too; its cell text survives.
 */
export function cleanSelectionForCopy(selection: string): string {
  const clean = selection
    .split("\n")
    .map((line) => line.replace(BOX_GLYPHS, "").replace(/[ \t]+(\r?)$/, "$1"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  return clean.trim() ? clean : "";
}

/** What a paste gesture found: text, or the path of an image the clipboard held instead. */
export interface PasteContent {
  text: string;
  imagePath: string | null;
}

/**
 * What a paste should put into the terminal, whichever gesture asked for it.
 *
 * Text first. Copying from a browser, Word, Excel or Outlook puts CF_DIB on the clipboard beside
 * the text, so asking for an image first answered a plain text copy with the path of a PNG the
 * user never took. With no text, a PTY carries bytes and cannot receive an image — but an agent
 * inside one can read a file, so the path is the thing that actually reaches it.
 */
export async function pasteContentFor(
  clipboard: ClipboardClient,
  platform: DesktopPlatform,
): Promise<PasteContent> {
  const text = await clipboard.readText();
  if (text) return { text, imagePath: null };
  const imagePath = await clipboard.readImagePath();
  if (imagePath === null) return { text: "", imagePath: null };
  return { text: quoteForShell(imagePath, platform), imagePath };
}

export async function pasteTextFor(
  clipboard: ClipboardClient,
  platform: DesktopPlatform,
): Promise<string> {
  return (await pasteContentFor(clipboard, platform)).text;
}

/**
 * OSC 52 for programs inside the terminal: `vim "+y`, tmux `set-clipboard on`, agent tools that
 * push a result to the clipboard. The addon's default provider uses `navigator.clipboard`, which
 * the desktop WebView refuses in ordinary situations, so writes go through the native client.
 * Reads answer "" always: a program in the PTY never gets to see what the clipboard holds.
 */
export function createOsc52ClipboardProvider(
  clipboard: ClipboardClient = clipboardClient,
  onNotice?: (notice: TerminalClipboardNotice) => void,
  onError?: (message: string) => void,
): IClipboardProvider {
  return {
    readText: () => "",
    writeText: (_selection, text) =>
      clipboard
        .writeText(text)
        .then(() => onNotice?.({ kind: "copied", text }))
        .catch((cause: unknown) => onError?.(`copy failed: ${describe(cause)}`)),
  };
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Wires the decision above into an xterm instance, and returns the disposer.
 *
 * Two hooks, because paste can come from either a key or a menu. The key handler consumes Ctrl+V
 * (Windows) or ⌘V (macOS) before xterm can turn it into PTY input. A capture-phase DOM `paste`
 * listener covers the context menu and Edit menu.
 *
 * Both consumed paths call preventDefault. Returning false to xterm does NOT cancel the browser's
 * own handling, and Ctrl+Shift+V is Chromium's "paste as plain text" — so the same keystroke could
 * paste twice.
 *
 * The disposer matters: terminals are RETAINED across page switches and this runs again on every
 * re-mount. attachCustomKeyEventHandler has a single slot and overwrites, but addEventListener
 * stacks, so N mounts of a pane would paste N times.
 *
 * `onNotice` fires only once a write has actually landed, so feedback never claims a copy that
 * the OS refused.
 */
export function attachTerminalClipboard(
  terminal: Terminal,
  platform: DesktopPlatform,
  clipboard: ClipboardClient = clipboardClient,
  onError?: (message: string) => void,
  onNotice?: (notice: TerminalClipboardNotice) => void,
): () => void {
  const report = (verb: string) => (cause: unknown) => onError?.(`${verb}: ${describe(cause)}`);

  let pasteInFlight: Promise<void> | null = null;
  const pasteFromClipboard = () => {
    // A WebView can dispatch a paste event around the same keydown even after preventDefault.
    // Share the pending native read so one gesture still reaches the PTY exactly once.
    if (pasteInFlight) return;
    pasteInFlight = pasteContentFor(clipboard, platform)
      .then(({ text, imagePath }) => {
        // terminal.paste() routes through onData with bracketed-paste framing, the same path typed
        // input takes, so a read-only terminal ignores it and a live one forwards it.
        if (!text) return;
        terminal.paste(text);
        if (imagePath !== null) onNotice?.({ kind: "imagePathPasted", path: imagePath });
      })
      .catch(report("paste failed"))
      .finally(() => {
        pasteInFlight = null;
      });
  };

  const copy = (text: string) =>
    clipboard.writeText(text).then(() => onNotice?.({ kind: "copied", text }));

  let selectionCopyTimer: ReturnType<typeof setTimeout> | undefined;
  const cancelSelectionCopy = () => {
    if (selectionCopyTimer !== undefined) clearTimeout(selectionCopyTimer);
    selectionCopyTimer = undefined;
  };
  const selectionChange = terminal.onSelectionChange(() => {
    const selection = terminal.getSelection();
    // Input, a buffer switch, or a vertical resize can clear xterm's selection before this debounce
    // ends. TALKAK keeps the last non-empty snapshot pending instead of cancelling that copy.
    if (!selection) return;
    const clean = cleanSelectionForCopy(selection);
    if (!clean) return;
    cancelSelectionCopy();
    // Delay the captured snapshot briefly, matching the original TALKAK terminal.
    selectionCopyTimer = setTimeout(() => {
      selectionCopyTimer = undefined;
      void copy(clean).catch(report("copy failed"));
    }, 120);
  });

  terminal.attachCustomKeyEventHandler((event) => {
    const action = terminalClipboardAction(event, terminal.hasSelection(), platform);
    if (action === "copy") {
      cancelSelectionCopy();
      const clean = cleanSelectionForCopy(terminal.getSelection());
      if (clean) {
        // The selection is cleared only once the write actually lands, so a failed copy stays
        // visibly selected instead of looking like it worked.
        void copy(clean)
          .then(() => terminal.clearSelection())
          .catch(report("copy failed"));
      }
      event.preventDefault();
      return false;
    }
    if (action === "paste") {
      event.preventDefault();
      pasteFromClipboard();
      return false;
    }
    return true;
  });

  const element = terminal.element ?? null;
  const onPaste = (event: Event) => {
    // The OS clipboard is read natively rather than from the event: a WebView paste of an image
    // pasteboard carries no text/plain at all, which is exactly the case this exists to serve.
    event.preventDefault();
    event.stopImmediatePropagation();
    pasteFromClipboard();
  };
  element?.addEventListener("paste", onPaste, true);

  return () => {
    cancelSelectionCopy();
    selectionChange.dispose();
    element?.removeEventListener("paste", onPaste, true);
    terminal.attachCustomKeyEventHandler(() => true);
  };
}
