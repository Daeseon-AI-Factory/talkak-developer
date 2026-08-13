import type { SessionClient, SessionRead } from "./sessionClient";

export interface SessionLogCursor {
  runId: number | null;
  after: number;
}

export interface SessionLogFrame {
  cursor: SessionLogCursor;
  bytes: number[];
  reset: boolean;
  truncated: boolean;
  running: boolean;
  readClosed: boolean;
  readError: string | null;
}

export const initialSessionLogCursor: SessionLogCursor = { runId: null, after: 0 };

export async function readSessionLogFrame(
  client: Pick<SessionClient, "read">,
  sessionId: string,
  cursor: SessionLogCursor,
): Promise<SessionLogFrame> {
  const first = await client.read(sessionId, cursor.after);
  if (cursor.runId !== null && first.runId !== cursor.runId) {
    const replay = await client.read(sessionId, 0);
    return frameFromRead(replay, true);
  }
  return frameFromRead(first, false);
}

function frameFromRead(read: SessionRead, reset: boolean): SessionLogFrame {
  return {
    cursor: { runId: read.runId, after: read.next },
    bytes: read.bytes,
    reset,
    truncated: read.truncated,
    running: read.running,
    readClosed: read.readClosed,
    readError: read.readError,
  };
}
