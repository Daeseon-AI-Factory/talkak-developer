import { invoke, isTauri } from "@tauri-apps/api/core";

export interface SpawnSessionInput {
  sessionId: string;
  cwd: string | null;
  command: string | null;
  args: string[];
  cols: number;
  rows: number;
}

export interface SessionSnapshot {
  sessionId: string;
  runId: number;
  processId: number | null;
  running: boolean;
  exitCode: number | null;
  readClosed: boolean;
  readError: string | null;
  /** Output high-water mark; replay up to here is history, not fresh output. */
  next: number;
}

export interface SessionRead {
  sessionId: string;
  runId: number;
  start: number;
  next: number;
  bytes: number[];
  truncated: boolean;
  running: boolean;
  exitCode: number | null;
  readClosed: boolean;
  readError: string | null;
}

export interface SessionClient {
  available: () => boolean;
  spawn: (request: SpawnSessionInput) => Promise<SessionSnapshot>;
  snapshot: (sessionId: string) => Promise<SessionSnapshot | null>;
  read: (sessionId: string, after: number) => Promise<SessionRead>;
  write: (sessionId: string, runId: number, data: Uint8Array) => Promise<void>;
  resize: (sessionId: string, runId: number, cols: number, rows: number) => Promise<void>;
  kill: (sessionId: string, runId: number) => Promise<SessionSnapshot>;
  discard: (sessionId: string) => Promise<void>;
}

export type InvokeCommand = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export function createSessionClient(
  invokeCommand: InvokeCommand,
  available: () => boolean,
): SessionClient {
  return {
    available,
    spawn: (request) => invokeCommand<SessionSnapshot>("session_spawn", { request }),
    snapshot: (sessionId) =>
      invokeCommand<SessionSnapshot | null>("session_snapshot", {
        request: { sessionId },
      }),
    read: (sessionId, after) =>
      invokeCommand<SessionRead>("session_read", {
        request: { sessionId, after },
      }),
    write: (sessionId, runId, data) =>
      invokeCommand<void>("session_write", {
        request: { sessionId, runId, data: Array.from(data) },
      }),
    resize: (sessionId, runId, cols, rows) =>
      invokeCommand<void>("session_resize", {
        request: { sessionId, runId, cols, rows },
      }),
    kill: (sessionId, runId) =>
      invokeCommand<SessionSnapshot>("session_kill", {
        request: { sessionId, runId },
      }),
    discard: (sessionId) =>
      invokeCommand<void>("session_discard", {
        request: { sessionId },
      }),
  };
}

export const sessionClient = createSessionClient(invoke, isTauri);

export function createSessionStarter(client: SessionClient) {
  const pending = new Map<string, Promise<SessionSnapshot>>();
  return (request: SpawnSessionInput, replaceDrainingSession = false): Promise<SessionSnapshot> => {
    const current = pending.get(request.sessionId);
    if (current) return current;
    const attempt = client
      .snapshot(request.sessionId)
      .then(async (snapshot) => {
        if (!snapshot) return client.spawn(request);
        if (snapshot.running || (!snapshot.readClosed && !replaceDrainingSession)) return snapshot;
        await client.discard(request.sessionId);
        return client.spawn(request);
      })
      .finally(() => {
        if (pending.get(request.sessionId) === attempt) pending.delete(request.sessionId);
      });
    pending.set(request.sessionId, attempt);
    return attempt;
  };
}

export const ensureSessionStarted = createSessionStarter(sessionClient);

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
