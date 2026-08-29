import { describe, expect, it } from "vitest";
import { type SessionRecoveryRecord, createBrowserSessionClient } from "./sessionClient";
import {
  type SessionRecoveryClient,
  createSessionRecoveryService,
  recoverySpawnInput,
  sessionRecoveryOutputPolicy,
} from "./sessionRecovery";

const record: SessionRecoveryRecord = {
  sessionId: "pane-1",
  cwd: "C:\\work\\app",
  command: "agent-cli",
  args: ["--resume", "task-1"],
  cols: 120,
  rows: 36,
  startedAtMs: 1_755_255_600_000,
  outputBytes: 3,
};

describe("session recovery", () => {
  it("loads native recovery records and their bounded raw output", async () => {
    const reads: string[] = [];
    const client = {
      available: () => true,
      recoveryCatalog: async () => ({ persisted: true, sessions: [record] }),
      readStoredOutput: async (sessionId: string) => {
        reads.push(sessionId);
        return [65, 13, 10];
      },
    } satisfies SessionRecoveryClient;
    const recovery = createSessionRecoveryService(client);

    await expect(recovery.inspect()).resolves.toEqual({
      nativeRuntimeAvailable: true,
      persistence: "available",
      sessions: [record],
      outputPolicy: sessionRecoveryOutputPolicy,
    });
    const output = await recovery.readOutput("pane-1");

    expect(reads).toEqual(["pane-1"]);
    expect(output).toEqual({
      sessionId: "pane-1",
      bytes: Uint8Array.from([65, 13, 10]),
      retention: "bounded-tail",
    });

    await expect(recovery.prepare(record)).resolves.toEqual({
      record,
      output: {
        sessionId: "pane-1",
        bytes: Uint8Array.from([65, 13, 10]),
        retention: "bounded-tail",
      },
      relaunch: {
        sessionId: "pane-1",
        cwd: "C:\\work\\app",
        command: "agent-cli",
        args: ["--resume", "task-1"],
        cols: 120,
        rows: 36,
      },
    });
    expect(reads).toEqual(["pane-1", "pane-1"]);
  });

  it("distinguishes the browser preview from a native store with no records", async () => {
    const recovery = createSessionRecoveryService(createBrowserSessionClient());

    await expect(recovery.inspect()).resolves.toEqual({
      nativeRuntimeAvailable: false,
      persistence: "unavailable",
      sessions: [],
      outputPolicy: sessionRecoveryOutputPolicy,
    });
    await expect(recovery.readOutput("pane-1")).resolves.toEqual({
      sessionId: "pane-1",
      bytes: new Uint8Array(),
      retention: "bounded-tail",
    });
  });

  it("turns a stored definition into an explicit relaunch without recovery metadata", () => {
    const input = recoverySpawnInput(record);

    expect(input).toEqual({
      sessionId: "pane-1",
      cwd: "C:\\work\\app",
      command: "agent-cli",
      args: ["--resume", "task-1"],
      cols: 120,
      rows: 36,
    });
    expect(input.args).not.toBe(record.args);
  });

  it("describes its output as a bounded tail, never a full transcript", () => {
    // The byte figures are checked against the Rust store itself in storeBounds.test.ts. Asserting
    // them here too only compared this file's literals with that file's literals: when the Rust
    // maximum moved from 4 MiB to 8 MiB, this test kept passing and the app kept telling users a
    // number that was half the truth.
    expect(sessionRecoveryOutputPolicy.kind).toBe("bounded-tail");
  });
});
