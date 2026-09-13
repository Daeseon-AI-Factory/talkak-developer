import type { TerminalRuntimeStatus } from "../domain";
import { createRuntimeMutationQueue, enqueueRuntimeMutation } from "./runtimeOperationGuard";
import { sessionClient } from "./sessionClient";

/**
 * The one way input reaches a session's PTY, whoever asks: the pane's own keystrokes, a paste, the
 * command palette dispatching a line, the phone composer's Send.
 *
 * Every writer goes through one queue keyed by session and run, so text from two sources cannot
 * interleave mid-line, and a resize sent by the pane stays ordered with the keystrokes around it.
 */
export const runtimeMutationQueue = createRuntimeMutationQueue();

const encoder = new TextEncoder();

/**
 * Write `data` to the session's live PTY. Resolves `false` — and sends nothing — when the session
 * has no running run to receive it; the caller decides whether that deserves a notice. A transport
 * failure goes to `onFailure` rather than throwing, matching how the pane reports its own faults.
 */
export function sendSessionInput(
  sessionId: string,
  runtime: TerminalRuntimeStatus | null | undefined,
  data: Uint8Array | string,
  onFailure: (cause: unknown) => void = () => undefined,
): Promise<boolean> {
  if (!runtime || runtime.phase !== "running" || runtime.runId === null) {
    return Promise.resolve(false);
  }
  const runId = runtime.runId;
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  if (bytes.length === 0) return Promise.resolve(true);
  let delivered = true;
  return enqueueRuntimeMutation(
    runtimeMutationQueue,
    sessionWriteKey(sessionId, runId),
    async () => {
      // The echo comes back on the output stream the moment the shell writes it; nothing here
      // has to go and fetch it.
      await sessionClient.write(sessionId, runId, bytes);
    },
    (cause) => {
      delivered = false;
      onFailure(cause);
    },
  ).then(() => delivered);
}

/** The queue key a pane's writes and resizes for one run share. */
export function sessionWriteKey(sessionId: string, runId: number): string {
  return JSON.stringify([sessionId, runId, "write"]);
}

/** Whether a session can take input right now — the same test `sendSessionInput` applies. */
export function sessionAcceptsInput(runtime: TerminalRuntimeStatus | null | undefined): boolean {
  return runtime?.phase === "running" && runtime.runId !== null;
}
