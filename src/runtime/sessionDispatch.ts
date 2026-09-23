import type { DevSession, TerminalRuntimeObservation } from "../domain";
import { retainedTerminal } from "../terminalInstances";
import { errorMessage } from "./sessionClient";
import { sendSessionInput } from "./sessionInput";

/**
 * Type `text` into a session from outside its pane — the palette's `>` line. Nothing is appended:
 * the line lands in the shell exactly as written and Enter stays the user's keystroke, so a
 * prompt can be aimed at a session without committing to it from a search box.
 *
 * Focus moves to the pane at once, so the Enter that follows goes where the text went. A transport
 * failure is reported the way the pane reports its own: as a write fault on the session's runtime
 * status, which the pane header and the attention centre already show.
 */
export function typeIntoSession(
  session: Pick<DevSession, "id" | "runtimeStatus">,
  text: string,
  report: (sessionId: string, observation: TerminalRuntimeObservation) => void,
  focusTerminal: (sessionId: string) => void = focusRetainedTerminal,
): Promise<boolean> {
  focusTerminal(session.id);
  return sendSessionInput(session.id, session.runtimeStatus, text, (cause) => {
    const current = session.runtimeStatus;
    if (!current) return;
    report(session.id, {
      ...current,
      fault: { operation: "write", message: errorMessage(cause) },
      origin: "runtime-event",
      observedAt: new Date().toISOString(),
    });
  });
}

function focusRetainedTerminal(sessionId: string): void {
  // Next frame: the palette's dialog is still open on this one, and the pane's own focus guard
  // will not move focus while a dialog is showing.
  requestAnimationFrame(() => retainedTerminal(sessionId)?.terminal.focus());
}
