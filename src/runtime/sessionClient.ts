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
  processId: number | null;
  running: boolean;
  exitCode: number | null;
  readClosed: boolean;
  readError: string | null;
}

export interface SessionRead {
  sessionId: string;
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
  write: (sessionId: string, data: Uint8Array) => Promise<void>;
  resize: (sessionId: string, cols: number, rows: number) => Promise<void>;
  kill: (sessionId: string) => Promise<SessionSnapshot>;
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
    write: (sessionId, data) =>
      invokeCommand<void>("session_write", {
        request: { sessionId, data: Array.from(data) },
      }),
    resize: (sessionId, cols, rows) =>
      invokeCommand<void>("session_resize", {
        request: { sessionId, cols, rows },
      }),
    kill: (sessionId) =>
      invokeCommand<SessionSnapshot>("session_kill", {
        request: { sessionId },
      }),
  };
}

export const sessionClient = createSessionClient(invoke, isTauri);

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
