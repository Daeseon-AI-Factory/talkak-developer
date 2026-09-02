import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { decodeBase64, encodeBase64 } from "./base64";
import { type SessionStreamFrame, decodeSessionFrame } from "./sessionFrame";

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
  bytes: Uint8Array;
  truncated: boolean;
  running: boolean;
  exitCode: number | null;
  readClosed: boolean;
  readError: string | null;
}

/** The native answer to `session_read`: bytes travel as one base64 string. */
interface SessionReadWire extends Omit<SessionRead, "bytes"> {
  bytes: string;
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

/** An open output stream; `detach` ends it. Frames stop arriving once detach is called. */
export interface SessionSubscription {
  detach: () => Promise<void>;
}

export interface SessionClient {
  available: () => boolean;
  liveSessions: () => Promise<LiveSession[]>;
  spawn: (request: SpawnSessionInput) => Promise<SessionSnapshot>;
  snapshot: (sessionId: string) => Promise<SessionSnapshot | null>;
  read: (sessionId: string, after: number) => Promise<SessionRead>;
  /**
   * Stream output from byte `after` onwards. The native side pushes a frame the moment the PTY
   * produces output — nothing polls — and the last frame carries `ended`. Frames arrive in order.
   */
  attach: (
    sessionId: string,
    after: number,
    onFrame: (frame: SessionStreamFrame) => void,
  ) => Promise<SessionSubscription>;
  write: (sessionId: string, runId: number, data: Uint8Array) => Promise<void>;
  resize: (sessionId: string, runId: number, cols: number, rows: number) => Promise<void>;
  kill: (sessionId: string, runId: number) => Promise<SessionSnapshot>;
  discard: (sessionId: string) => Promise<void>;
}

export type InvokeCommand = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** The part of a Tauri channel this client needs; a test hands in a plain object. */
export interface FrameChannel {
  onmessage: (message: ArrayBuffer) => void;
}

export function createSessionClient(
  invokeCommand: InvokeCommand,
  available: () => boolean,
  createChannel: () => FrameChannel = () => new Channel<ArrayBuffer>(),
): SessionClient {
  return {
    available,
    liveSessions: () => invokeCommand<LiveSession[]>("session_live"),
    spawn: (request) => invokeCommand<SessionSnapshot>("session_spawn", { request }),
    snapshot: (sessionId) =>
      invokeCommand<SessionSnapshot | null>("session_snapshot", {
        request: { sessionId },
      }),
    read: async (sessionId, after) => {
      const wire = await invokeCommand<SessionReadWire>("session_read", {
        request: { sessionId, after },
      });
      return { ...wire, bytes: decodeBase64(wire.bytes) };
    },
    attach: async (sessionId, after, onFrame) => {
      const channel = createChannel();
      channel.onmessage = (message) => onFrame(decodeSessionFrame(message));
      const subscription = await invokeCommand<number>("session_attach", {
        request: { sessionId, after },
        onFrame: channel,
      });
      return {
        detach: () => invokeCommand<void>("session_detach", { subscription }),
      };
    },
    write: (sessionId, runId, data) =>
      invokeCommand<void>("session_write", {
        request: { sessionId, runId, data: encodeBase64(data) },
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

/** Browser preview counterpart: it exposes no fake native sessions and native mutations fail. */
export function createBrowserSessionClient(): SessionClient {
  return {
    available: () => false,
    liveSessions: async () => [],
    spawn: () => nativeSessionUnavailable(),
    snapshot: () => nativeSessionUnavailable(),
    read: () => nativeSessionUnavailable(),
    attach: () => nativeSessionUnavailable(),
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
