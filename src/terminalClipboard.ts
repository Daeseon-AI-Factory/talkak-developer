import type { Terminal } from "@xterm/xterm";
import type { DesktopPlatform } from "./platform";

/**
 * Clipboard keys for a terminal pane, the way Windows Terminal settled them: Ctrl+C copies when
 * text is selected and interrupts when none is, Ctrl+Shift+C always copies, Ctrl+Shift+V pastes.
 * Plain Ctrl+V stays with the WebView, whose native paste already reaches xterm. macOS is left
 * entirely native — ⌘C/⌘V work through the WebView, and Ctrl+C there must stay an interrupt.
 */

export type TerminalClipboardAction = "copy" | "paste" | "passthrough";

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
export function attachTerminalClipboard(terminal: Terminal, platform: DesktopPlatform): void {
  terminal.attachCustomKeyEventHandler((event) => {
    const action = terminalClipboardAction(event, terminal.hasSelection(), platform);
    if (action === "copy") {
      const selection = terminal.getSelection();
      if (selection) {
        // Failure leaves the selection in place, so the user sees the copy did not take.
        void navigator.clipboard.writeText(selection).then(() => terminal.clearSelection());
      }
      return false;
    }
    if (action === "paste") {
      void navigator.clipboard.readText().then((text) => {
        // terminal.paste() routes through onData with bracketed-paste framing, the same path
        // typed input takes, so a read-only terminal ignores it and a live one forwards it.
        if (text) terminal.paste(text);
      });
      return false;
    }
    return true;
  });
}
