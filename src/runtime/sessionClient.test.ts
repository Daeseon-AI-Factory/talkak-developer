import { describe, expect, it } from "vitest";
import {
  type FrameChannel,
  type InvokeCommand,
  type SessionClient,
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
    await client.write("session-1", 1, Uint8Array.from([65, 13]));
    await client.resize("session-1", 1, 100, 40);
    await client.kill("session-1", 1);
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
        args: { request: { sessionId: "session-1", runId: 1, data: "QQ0=" } },
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

  it("decodes a polled read's base64 payload into bytes", async () => {
    const invokeCommand: InvokeCommand = async <T>() =>
      ({
        sessionId: "session-1",
        runId: 3,
        start: 10,
        next: 16,
        bytes: "G1szMW1yZWQbWzBt".slice(0, 8),
        truncated: false,
        running: true,
        exitCode: null,
        readClosed: false,
        readError: null,
      }) as T;
    const client = createSessionClient(invokeCommand, () => true);

    const read = await client.read("session-1", 10);

    expect(read.runId).toBe(3);
    expect(read.bytes).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(read.bytes)).toBe("\u001b[31mr");
  });

  it("opens a stream over a channel and hands every frame, decoded, to the caller", async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = [];
    let channel: FrameChannel | undefined;
    const invokeCommand: InvokeCommand = async <T>(
      command: string,
      args?: Record<string, unknown>,
    ) => {
      calls.push({ command, args });
      return (command === "session_attach" ? 41 : undefined) as T;
    };
    const client = createSessionClient(
      invokeCommand,
      () => true,
      () => {
        channel = { onmessage: () => undefined };
        return channel;
      },
    );
    const frames: number[] = [];

    const subscription = await client.attach("session-1", 1000, (frame) => frames.push(frame.next));
    if (!channel) throw new Error("no channel was created");
    // The fixture pinned by sessionFrame.test.ts: runId 7, start 1000, next 1006.
    channel.onmessage(
      Uint8Array.from([
        1, 3, 7, 0, 0, 0, 0, 0, 0, 0, 232, 3, 0, 0, 0, 0, 0, 0, 238, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 104, 105, 27, 91, 48, 109,
      ]).buffer,
    );
    await subscription.detach();

    expect(frames).toEqual([1006]);
    expect(calls[0]).toEqual({
      command: "session_attach",
      args: { request: { sessionId: "session-1", after: 1000 }, onFrame: channel },
    });
    expect(calls[1]).toEqual({ command: "session_detach", args: { subscription: 41 } });
  });

  it("has an honest browser counterpart without pretending native sessions exist", async () => {
    const client = createBrowserSessionClient();

    expect(client.available()).toBe(false);
    await expect(client.liveSessions()).resolves.toEqual([]);
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
      snapshot: async () => {
        snapshots += 1;
        return null;
      },
      spawn: async () => {
        spawns += 1;
        return running;
      },
      read: async () => uncalled("read"),
      attach: async () => uncalled("attach"),
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
      snapshot: async () => existing,
      spawn: async () => {
        spawns += 1;
        return existing;
      },
      read: async () => uncalled("read"),
      attach: async () => uncalled("attach"),
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
      snapshot: async () => exited,
      spawn: async () => {
        operations.push("spawn");
        return restarted;
      },
      read: async () => uncalled("read"),
      attach: async () => uncalled("attach"),
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
      snapshot: async () => draining,
      spawn: async () => uncalled("spawn"),
      read: async () => uncalled("read"),
      attach: async () => uncalled("attach"),
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
      snapshot: async () => draining,
      spawn: async () => {
        operations.push("spawn");
        return restarted;
      },
      read: async () => uncalled("read"),
      attach: async () => uncalled("attach"),
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
