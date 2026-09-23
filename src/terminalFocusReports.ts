/**
 * xterm's focus reports, CSI I (focus in) and CSI O (focus out).
 *
 * xterm emits them through onData ONLY while the program in the PTY has enabled DECSET ?1004 —
 * verified against the shipped xterm 6.0.0 bundle: `sendFocus && triggerDataEvent(ESC "[I")`. A
 * program that asked for them is a program that reads them (tmux `focus-events on`, vim/neovim
 * FocusGained and autoread), so dropping them unconditionally would break every such program to
 * work around one that mishandles them. The full Talkak app strips them on the theory that a bare
 * ESC reads as an interrupt in one agent's TUI; its own incident record later traced that
 * "Interrupted" to a Ctrl+digit chord leaking to xterm, not to focus reports.
 *
 * The helper exists, tested, but is NOT wired into the pane: `FOCUS_REPORT_STRIPPING_ENABLED` is
 * false until the symptom is reproduced in this app with a real program that enables ?1004. Flip
 * it and route `onData` through `stripFocusReports` if that day comes.
 */

const ESC = "";
const FOCUS_REPORT = new RegExp(`${ESC}\\[[IO]`, "g");

/** Whether the pane drops focus reports before they reach the PTY. Deliberately off; see above. */
export const FOCUS_REPORT_STRIPPING_ENABLED = false;

export function stripFocusReports(data: string): string {
  return data.replace(FOCUS_REPORT, "");
}
