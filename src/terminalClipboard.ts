import type { Terminal } from "@xterm/xterm";
import type { DesktopPlatform } from "./platform";
import { type ClipboardClient, clipboardClient } from "./runtime/clipboardClient";

/**
 * Clipboard keys for a terminal pane, the way Windows Terminal settled them: Ctrl+C copies when
 * text is selected and interrupts when none is, Ctrl+Shift+C always copies, Ctrl+Shift+V pastes.
 * Plain Ctrl+V stays with the WebView, whose native paste already reaches xterm. macOS is left
 * entirely native — ⌘C/⌘V work through the WebView, and Ctrl+C there must stay an interrupt.
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
  if (platform === "macos") return "passthrough";
  if (event.type !== "keydown") return "passthrough";
  if (!event.ctrlKey || event.altKey || event.metaKey) return "passthrough";
  if (event.code === "KeyC" && (event.shiftKey || hasSelection)) return "copy";
  if (event.code === "KeyV" && event.shiftKey) return "paste";
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
 * Two hooks, because one gesture is not enough. The key handler covers Ctrl+Shift+V, the chord
 * Windows Terminal established. A capture-phase DOM `paste` listener covers everything else — plain
 * Ctrl+V, ⌘V, the context menu, the Edit menu — which is the only way macOS gets image paste at
 * all: `terminalClipboardAction` returns passthrough there before any branch runs (correctly, since
 * Ctrl+C must stay an interrupt), so the app's own paste code never executed on a mac and ⌘V with
 * an image on the clipboard sent an empty bracketed paste and nothing else.
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

  const pasteFromClipboard = () => {
    void pasteTextFor(clipboard, platform)
      .then((text) => {
        // terminal.paste() routes through onData with bracketed-paste framing, the same path typed
        // input takes, so a read-only terminal ignores it and a live one forwards it.
        if (text) terminal.paste(text);
      })
      .catch(report("paste failed"));
  };

  terminal.attachCustomKeyEventHandler((event) => {
    const action = terminalClipboardAction(event, terminal.hasSelection(), platform);
    if (action === "copy") {
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
    event.stopPropagation();
    pasteFromClipboard();
  };
  element?.addEventListener("paste", onPaste, true);

  return () => {
    element?.removeEventListener("paste", onPaste, true);
    terminal.attachCustomKeyEventHandler(() => true);
  };
}
