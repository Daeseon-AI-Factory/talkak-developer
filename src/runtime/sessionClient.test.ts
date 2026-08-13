import { describe, expect, it } from "vitest";
import {
  type InvokeCommand,
  type SessionClient,
  type SessionSnapshot,
  createSessionClient,
  createSessionStarter,
} from "./sessionClient";

describe("session client", () => {
  it("keeps the Tauri command boundary typed and request-shaped", async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = [];
    const snapshot: SessionSnapshot = {
      sessionId: "session-1",
      runId: 1,
      processId: 42,
      running: true,
      exitCode: null,
      readClosed: false,
      readError: null,
    };
    const invokeCommand: InvokeCommand = async <T>(
      command: string,
      args?: Record<string, unknown>,
    ) => {
      calls.push({ command, args });
      return snapshot as T;
    };
    const client = createSessionClient(invokeCommand, () => true);

    await client.spawn({
      sessionId: "session-1",
      cwd: "/project",
      command: null,
      args: [],
      cols: 80,
      rows: 24,
    });
    await client.write("session-1", Uint8Array.from([65, 13]));
    await client.discard("session-1");

    expect(calls).toEqual([
      {
        command: "session_spawn",
        args: {
          request: {
            sessionId: "session-1",
            cwd: "/project",
            command: null,
            args: [],
            cols: 80,
            rows: 24,
          },
        },
      },
      {
        command: "session_write",
        args: { request: { sessionId: "session-1", data: [65, 13] } },
      },
      {
        command: "session_discard",
        args: { request: { sessionId: "session-1" } },
      },
    ]);
  });

  it("coalesces concurrent starts for one session id", async () => {
    let snapshots = 0;
    let spawns = 0;
    const running: SessionSnapshot = {
      sessionId: "session-1",
      runId: 1,
      processId: 42,
      running: true,
      exitCode: null,
      readClosed: false,
      readError: null,
    };
    const client = {
      available: () => true,
      snapshot: async () => {
        snapshots += 1;
        return null;
      },
      spawn: async () => {
        spawns += 1;
        return running;
      },
      read: async () => uncalled("read"),
      write: async () => uncalled("write"),
      resize: async () => uncalled("resize"),
      kill: async () => uncalled("kill"),
      discard: async () => uncalled("discard"),
    } satisfies SessionClient;
    const start = createSessionStarter(client);
    const request = {
      sessionId: "session-1",
      cwd: "/project",
      command: null,
      args: [],
      cols: 80,
      rows: 24,
    };

    const [first, second] = await Promise.all([start(request), start(request)]);
    expect(first).toEqual(running);
    expect(second).toEqual(running);
    expect(snapshots).toBe(1);
    expect(spawns).toBe(1);
  });

  it("reattaches an existing session without spawning", async () => {
    const existing: SessionSnapshot = {
      sessionId: "session-1",
      runId: 1,
      processId: 42,
      running: true,
      exitCode: null,
      readClosed: false,
      readError: null,
    };
    let spawns = 0;
    const client = {
      available: () => true,
      snapshot: async () => existing,
      spawn: async () => {
        spawns += 1;
        return existing;
      },
      read: async () => uncalled("read"),
      write: async () => uncalled("write"),
      resize: async () => uncalled("resize"),
      kill: async () => uncalled("kill"),
      discard: async () => uncalled("discard"),
    } satisfies SessionClient;
    const start = createSessionStarter(client);

    await start({
      sessionId: "session-1",
      cwd: "/project",
      command: null,
      args: [],
      cols: 80,
      rows: 24,
    });
    expect(spawns).toBe(0);
  });

  it("discards a fully exited session before starting it again", async () => {
    const exited: SessionSnapshot = {
      sessionId: "session-1",
      runId: 1,
      processId: 42,
      running: false,
      exitCode: 0,
      readClosed: true,
      readError: null,
    };
    const restarted: SessionSnapshot = {
      sessionId: "session-1",
      runId: 2,
      processId: 84,
      running: true,
      exitCode: null,
      readClosed: false,
      readError: null,
    };
    const operations: string[] = [];
    const client = {
      available: () => true,
      snapshot: async () => exited,
      spawn: async () => {
        operations.push("spawn");
        return restarted;
      },
      read: async () => uncalled("read"),
      write: async () => uncalled("write"),
      resize: async () => uncalled("resize"),
      kill: async () => uncalled("kill"),
      discard: async () => {
        operations.push("discard");
      },
    } satisfies SessionClient;

    const start = createSessionStarter(client);
    const request = {
      sessionId: "session-1",
      cwd: "/project",
      command: null,
      args: [],
      cols: 80,
      rows: 24,
    };
    const [first, second] = await Promise.all([start(request), start(request)]);

    expect(operations).toEqual(["discard", "spawn"]);
    expect(first).toEqual(restarted);
    expect(second).toEqual(restarted);
  });

  it("keeps an exited session while its output reader is still draining", async () => {
    const draining: SessionSnapshot = {
      sessionId: "session-1",
      runId: 1,
      processId: 42,
      running: false,
      exitCode: 0,
      readClosed: false,
      readError: null,
    };
    const client = {
      available: () => true,
      snapshot: async () => draining,
      spawn: async () => uncalled("spawn"),
      read: async () => uncalled("read"),
      write: async () => uncalled("write"),
      resize: async () => uncalled("resize"),
      kill: async () => uncalled("kill"),
      discard: async () => uncalled("discard"),
    } satisfies SessionClient;

    const result = await createSessionStarter(client)({
      sessionId: "session-1",
      cwd: "/project",
      command: null,
      args: [],
      cols: 80,
      rows: 24,
    });

    expect(result).toEqual(draining);
  });
});

function uncalled(operation: string): never {
  throw new Error(`Unexpected ${operation} call`);
}
