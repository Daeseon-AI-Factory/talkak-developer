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

/**
 * What a paste should put into the terminal, whichever gesture asked for it.
 *
 * Text first. Copying from a browser, Word, Excel or Outlook puts CF_DIB on the clipboard beside
 * the text, so asking for an image first answered a plain text copy with the path of a PNG the
 * user never took. With no text, a PTY carries bytes and cannot receive an image — but an agent
 * inside one can read a file, so the path is the thing that actually reaches it.
 */
export async function pasteTextFor(
  clipboard: ClipboardClient,
  platform: DesktopPlatform,
): Promise<string> {
  const text = await clipboard.readText();
  if (text) return text;
  const imagePath = await clipboard.readImagePath();
  return imagePath === null ? "" : quoteForShell(imagePath, platform);
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
 */
export function attachTerminalClipboard(
  terminal: Terminal,
  platform: DesktopPlatform,
  clipboard: ClipboardClient = clipboardClient,
  onError?: (message: string) => void,
): () => void {
  const report = (verb: string) => (cause: unknown) =>
    onError?.(`${verb}: ${cause instanceof Error ? cause.message : String(cause)}`);

  let pasteInFlight: Promise<void> | null = null;
  const pasteFromClipboard = () => {
    // A WebView can dispatch a paste event around the same keydown even after preventDefault.
    // Share the pending native read so one gesture still reaches the PTY exactly once.
    if (pasteInFlight) return;
    pasteInFlight = pasteTextFor(clipboard, platform)
      .then((text) => {
        // terminal.paste() routes through onData with bracketed-paste framing, the same path typed
        // input takes, so a read-only terminal ignores it and a live one forwards it.
        if (text) terminal.paste(text);
      })
      .catch(report("paste failed"))
      .finally(() => {
        pasteInFlight = null;
      });
  };

  let selectionCopyTimer: ReturnType<typeof setTimeout> | undefined;
  const cancelSelectionCopy = () => {
    if (selectionCopyTimer !== undefined) clearTimeout(selectionCopyTimer);
    selectionCopyTimer = undefined;
  };
  const selectionChange = terminal.onSelectionChange(() => {
    cancelSelectionCopy();
    const selection = terminal.getSelection();
    if (!selection) return;
    // Dragging changes the selection many times. Copy the settled selection once, with the same
    // short debounce used by the original TALKAK terminal.
    selectionCopyTimer = setTimeout(() => {
      selectionCopyTimer = undefined;
      const settledSelection = terminal.getSelection();
      if (settledSelection) {
        void clipboard.writeText(settledSelection).catch(report("copy failed"));
      }
    }, 120);
  });

  terminal.attachCustomKeyEventHandler((event) => {
    const action = terminalClipboardAction(event, terminal.hasSelection(), platform);
    if (action === "copy") {
      cancelSelectionCopy();
      const selection = terminal.getSelection();
      if (selection) {
        // The selection is cleared only once the write actually lands, so a failed copy stays
        // visibly selected instead of looking like it worked.
        void clipboard
          .writeText(selection)
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
