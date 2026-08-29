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
 * Wires the decision above into an xterm instance. Returns false to xterm exactly when the key was
 * consumed here, so a copy never doubles as an interrupt.
 */
export function attachTerminalClipboard(
  terminal: Terminal,
  platform: DesktopPlatform,
  clipboard: ClipboardClient = clipboardClient,
  onError?: (message: string) => void,
): void {
  const report = (verb: string) => (cause: unknown) =>
    onError?.(`${verb}: ${cause instanceof Error ? cause.message : String(cause)}`);

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
      return false;
    }
    if (action === "paste") {
      void clipboard
        .readText()
        .then(async (text) => {
          // Text first. Copying from a browser, Word, Excel or Outlook puts CF_DIB on the clipboard
          // beside the text, so asking for an image first answered a plain text copy with a PNG
          // path — the user pasted a screenshot they never took.
          if (text) return text;
          // No text: a PTY carries bytes, so an image cannot arrive in a terminal as an image, and
          // an agent running inside one cannot reach the clipboard the way it could in its own
          // window. Pasting the file path is what actually reaches the agent — and what it wanted.
          const imagePath = await clipboard.readImagePath();
          return imagePath === null ? "" : quoteForShell(imagePath, platform);
        })
        .then((text) => {
          // terminal.paste() routes through onData with bracketed-paste framing, the same path
          // typed input takes, so a read-only terminal ignores it and a live one forwards it.
          if (text) terminal.paste(text);
        })
        .catch(report("paste failed"));
      return false;
    }
    return true;
  });
}
