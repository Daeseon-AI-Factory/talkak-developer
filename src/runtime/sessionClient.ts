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

/**
 * A best-effort disk record that can recreate a session after a machine restart. The process
 * itself did not survive the restart, and its retained output is a bounded tail rather than a
 * complete transcript.
 */
export interface SessionRecoveryRecord {
  sessionId: string;
  cwd: string | null;
  command: string | null;
  args: string[];
  cols: number;
  rows: number;
  startedAtMs: number;
  /** Bytes currently retained on disk; the backend keeps at most 4 MiB per session. */
  outputBytes: number;
}

export interface SessionRecoveryCatalog {
  /** False means the native store was unavailable, not that recovery was checked and found empty. */
  persisted: boolean;
  sessions: SessionRecoveryRecord[];
}

/**
 * A session the broker is holding right now — the `tmux ls` view. Sessions outlive the panes that
 * opened them by design, so this is the only way to find a shell nothing is watching any more.
 */
export interface LiveSession {
  sessionId: string;
  runId: number;
  processId: number | null;
  running: boolean;
}

export interface SessionClient {
  available: () => boolean;
  liveSessions: () => Promise<LiveSession[]>;
  recoveryCatalog: () => Promise<SessionRecoveryCatalog>;
  readStoredOutput: (sessionId: string) => Promise<number[]>;
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
    liveSessions: () => invokeCommand<LiveSession[]>("session_live"),
    recoveryCatalog: () => invokeCommand<SessionRecoveryCatalog>("session_restorable"),
    readStoredOutput: (sessionId) =>
      invokeCommand<number[]>("session_stored_output", {
        request: { sessionId },
      }),
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

/** Browser preview counterpart: recovery reports persistence as unavailable; native mutations fail. */
export function createBrowserSessionClient(): SessionClient {
  return {
    available: () => false,
    liveSessions: async () => [],
    recoveryCatalog: async () => ({ persisted: false, sessions: [] }),
    readStoredOutput: async () => [],
    spawn: () => nativeSessionUnavailable(),
    snapshot: () => nativeSessionUnavailable(),
    read: () => nativeSessionUnavailable(),
    write: () => nativeSessionUnavailable(),
    resize: () => nativeSessionUnavailable(),
    kill: () => nativeSessionUnavailable(),
    discard: () => nativeSessionUnavailable(),
  };
}

export const sessionClient = isTauri()
  ? createSessionClient(invoke, isTauri)
  : createBrowserSessionClient();

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

function nativeSessionUnavailable<T>(): Promise<T> {
  return Promise.reject(new Error("Native session runtime is unavailable in the browser preview."));
}
