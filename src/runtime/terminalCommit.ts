/**
 * A session's emulator survives its React mounts. Its write + cursor commit must survive with
 * it: a foreground and background stream can otherwise submit overlapping bytes while the old
 * mount's xterm callback is still pending. Recheck the shared cursor INSIDE this queue.
 * Different sessions never wait on each other; a rejected write does not poison the next mount.
 */
const pending = new Map<string, Promise<void>>();

export function serializeTerminalCommit(
  sessionId: string,
  commit: () => Promise<boolean>,
): Promise<boolean> {
  const operation = (pending.get(sessionId) ?? Promise.resolve()).then(commit);
  const settled = operation.then(
    () => undefined,
    () => undefined,
  );
  pending.set(sessionId, settled);
  void settled.then(() => {
    if (pending.get(sessionId) === settled) pending.delete(sessionId);
  });
  return operation;
}
