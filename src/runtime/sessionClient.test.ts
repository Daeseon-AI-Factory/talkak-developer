import { describe, expect, it } from "vitest";
import {
  type InvokeCommand,
  type SessionClient,
  type SessionRecoveryCatalog,
  type SessionSnapshot,
  createBrowserSessionClient,
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
      next: 0,
    };
    const recoveryCatalog: SessionRecoveryCatalog = {
      persisted: true,
      sessions: [
        {
          sessionId: "session-1",
          cwd: "/project",
          command: null,
          args: [],
          cols: 80,
          rows: 24,
          startedAtMs: 1_755_255_600_000,
          outputBytes: 12,
        },
      ],
    };
    const invokeCommand: InvokeCommand = async <T>(
      command: string,
      args?: Record<string, unknown>,
    ) => {
      calls.push({ command, args });
      if (command === "session_restorable") return recoveryCatalog as T;
      if (command === "session_stored_output") return [65, 13] as T;
      return snapshot as T;
    };
    const client = createSessionClient(invokeCommand, () => true);

    await expect(client.recoveryCatalog()).resolves.toEqual(recoveryCatalog);
    await expect(client.readStoredOutput("session-1")).resolves.toEqual([65, 13]);
    await client.spawn({
      sessionId: "session-1",
      cwd: "/project",
      command: null,
      args: [],
      cols: 80,
      rows: 24,
    });
    await client.write("session-1", 1, Uint8Array.from([65, 13]));
    await client.resize("session-1", 1, 100, 40);
    await client.kill("session-1", 1);
    await client.discard("session-1");

    expect(calls).toEqual([
      {
        command: "session_restorable",
        args: undefined,
      },
      {
        command: "session_stored_output",
        args: { request: { sessionId: "session-1" } },
      },
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
        args: { request: { sessionId: "session-1", runId: 1, data: [65, 13] } },
      },
      {
        command: "session_resize",
        args: { request: { sessionId: "session-1", runId: 1, cols: 100, rows: 40 } },
      },
      {
        command: "session_kill",
        args: { request: { sessionId: "session-1", runId: 1 } },
      },
      {
        command: "session_discard",
        args: { request: { sessionId: "session-1" } },
      },
    ]);
  });

  it("has an honest browser counterpart without pretending that an empty restore list persisted", async () => {
    const client = createBrowserSessionClient();

    expect(client.available()).toBe(false);
    await expect(client.recoveryCatalog()).resolves.toEqual({ persisted: false, sessions: [] });
    await expect(client.readStoredOutput("session-1")).resolves.toEqual([]);
    await expect(
      client.spawn({
        sessionId: "session-1",
        cwd: null,
        command: null,
        args: [],
        cols: 80,
        rows: 24,
      }),
    ).rejects.toThrow("Native session runtime is unavailable");
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
      next: 0,
    };
    const client = {
      available: () => true,
      liveSessions: async () => uncalled("liveSessions"),
      recoveryCatalog: async () => uncalled("recoveryCatalog"),
      readStoredOutput: async () => uncalled("readStoredOutput"),
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
      next: 0,
    };
    let spawns = 0;
    const client = {
      available: () => true,
      liveSessions: async () => uncalled("liveSessions"),
      recoveryCatalog: async () => uncalled("recoveryCatalog"),
      readStoredOutput: async () => uncalled("readStoredOutput"),
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
      next: 0,
    };
    const restarted: SessionSnapshot = {
      sessionId: "session-1",
      runId: 2,
      processId: 84,
      running: true,
      exitCode: null,
      readClosed: false,
      readError: null,
      next: 0,
    };
    const operations: string[] = [];
    const client = {
      available: () => true,
      liveSessions: async () => uncalled("liveSessions"),
      recoveryCatalog: async () => uncalled("recoveryCatalog"),
      readStoredOutput: async () => uncalled("readStoredOutput"),
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

  it("keeps an exited session until its output buffer was observed drained", async () => {
    const draining: SessionSnapshot = {
      sessionId: "session-1",
      runId: 1,
      processId: 42,
      running: false,
      exitCode: 0,
      readClosed: false,
      readError: null,
      next: 0,
    };
    const client = {
      available: () => true,
      liveSessions: async () => uncalled("liveSessions"),
      recoveryCatalog: async () => uncalled("recoveryCatalog"),
      readStoredOutput: async () => uncalled("readStoredOutput"),
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

  it("restarts a draining session after its output buffer was observed empty", async () => {
    const draining: SessionSnapshot = {
      sessionId: "session-1",
      runId: 1,
      processId: 42,
      running: false,
      exitCode: 0,
      readClosed: false,
      readError: null,
      next: 0,
    };
    const restarted: SessionSnapshot = {
      sessionId: "session-1",
      runId: 2,
      processId: 84,
      running: true,
      exitCode: null,
      readClosed: false,
      readError: null,
      next: 0,
    };
    const operations: string[] = [];
    const client = {
      available: () => true,
      liveSessions: async () => uncalled("liveSessions"),
      recoveryCatalog: async () => uncalled("recoveryCatalog"),
      readStoredOutput: async () => uncalled("readStoredOutput"),
      snapshot: async () => draining,
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

    const result = await createSessionStarter(client)(
      {
        sessionId: "session-1",
        cwd: "/project",
        command: null,
        args: [],
        cols: 80,
        rows: 24,
      },
      true,
    );

    expect(operations).toEqual(["discard", "spawn"]);
    expect(result).toEqual(restarted);
  });
});

function uncalled(operation: string): never {
  throw new Error(`Unexpected ${operation} call`);
}
