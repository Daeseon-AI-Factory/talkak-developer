import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import type { SessionLogCursor } from "./runtime/sessionLogModel";

/**
 * Inspector tabs unmount when the user switches away. Keep the parsed terminal buffer and broker
 * cursor per session so reopening the log only reads output that arrived while it was hidden.
 */
export interface RetainedTerminalLog {
  terminal: Terminal;
  fitAddon: FitAddon;
  cursor: SessionLogCursor;
  truncated: boolean;
}

const retained = new Map<string, RetainedTerminalLog>();
const pendingCommits = new Map<string, Promise<void>>();

export function retainedTerminalLog(sessionId: string): RetainedTerminalLog | undefined {
  return retained.get(sessionId);
}

/** Every retained log emulator, for the CI test hooks. */
export function retainedTerminalLogs(): ReadonlyMap<string, RetainedTerminalLog> {
  return retained;
}

export function retainTerminalLog(sessionId: string, entry: RetainedTerminalLog): void {
  retained.set(sessionId, entry);
  pendingCommits.set(sessionId, Promise.resolve());
}

/**
 * Serializes an xterm write with the cursor it represents. A returning inspector waits for this
 * pair before reading, so it cannot replay the same broker bytes while the previous xterm write is
 * still finishing after its DOM has been detached.
 */
export function commitRetainedTerminalLogFrame(
  sessionId: string,
  cursor: SessionLogCursor,
  truncated: boolean,
  write: () => Promise<boolean>,
): Promise<boolean> {
  const entry = retained.get(sessionId);
  if (!entry) return Promise.resolve(false);

  const previous = pendingCommits.get(sessionId) ?? Promise.resolve();
  const operation = previous.then(async () => {
    const written = await write();
    if (!written || retained.get(sessionId) !== entry) return false;
    entry.cursor = cursor;
    entry.truncated = truncated;
    return true;
  });
  pendingCommits.set(
    sessionId,
    operation.then(
      () => undefined,
      () => undefined,
    ),
  );
  return operation;
}

export async function waitForRetainedTerminalLogCommit(sessionId: string): Promise<void> {
  await pendingCommits.get(sessionId);
}

export function releaseTerminalLog(sessionId: string): void {
  const entry = retained.get(sessionId);
  if (!entry) return;
  retained.delete(sessionId);
  pendingCommits.delete(sessionId);
  entry.terminal.dispose();
}
