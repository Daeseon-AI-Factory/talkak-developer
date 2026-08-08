import { describe, expect, it } from "vitest";
import { type InvokeCommand, type SessionSnapshot, createSessionClient } from "./sessionClient";

describe("session client", () => {
  it("keeps the Tauri command boundary typed and request-shaped", async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = [];
    const snapshot: SessionSnapshot = {
      sessionId: "session-1",
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
    ]);
  });
});
