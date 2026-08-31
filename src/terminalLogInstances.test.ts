import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import {
  commitRetainedTerminalLogFrame,
  releaseTerminalLog,
  retainTerminalLog,
  retainedTerminalLog,
  waitForRetainedTerminalLogCommit,
} from "./terminalLogInstances";

describe("terminal log retention", () => {
  it("keeps the emulator and read cursor across inspector unmounts", () => {
    const sessionId = "terminal-log-retention";
    const dispose = vi.fn();
    const terminal = { dispose } as unknown as Terminal;
    const fitAddon = {} as FitAddon;

    retainTerminalLog(sessionId, {
      terminal,
      fitAddon,
      cursor: { runId: 1, after: 65536 },
      truncated: false,
    });
    void commitRetainedTerminalLogFrame(
      sessionId,
      { runId: 1, after: 1048576 },
      true,
      async () => true,
    );

    return waitForRetainedTerminalLogCommit(sessionId).then(() => {
      expect(retainedTerminalLog(sessionId)).toEqual({
        terminal,
        fitAddon,
        cursor: { runId: 1, after: 1048576 },
        truncated: true,
      });
      expect(dispose).not.toHaveBeenCalled();

      releaseTerminalLog(sessionId);
      expect(dispose).toHaveBeenCalledOnce();
      expect(retainedTerminalLog(sessionId)).toBeUndefined();
    });
  });

  it("makes a rapid remount wait for a delayed write and its cursor commit", async () => {
    const sessionId = "terminal-log-delayed-write";
    const terminal = { dispose: vi.fn() } as unknown as Terminal;
    const fitAddon = {} as FitAddon;
    let finishWrite: ((written: boolean) => void) | undefined;
    const delayedWrite = new Promise<boolean>((resolve) => {
      finishWrite = resolve;
    });

    retainTerminalLog(sessionId, {
      terminal,
      fitAddon,
      cursor: { runId: 4, after: 0 },
      truncated: false,
    });
    const commit = commitRetainedTerminalLogFrame(
      sessionId,
      { runId: 4, after: 65536 },
      false,
      () => delayedWrite,
    );
    let remountCursor: number | undefined;
    const remount = waitForRetainedTerminalLogCommit(sessionId).then(() => {
      remountCursor = retainedTerminalLog(sessionId)?.cursor.after;
    });

    await Promise.resolve();
    expect(remountCursor).toBeUndefined();
    expect(retainedTerminalLog(sessionId)?.cursor.after).toBe(0);

    finishWrite?.(true);
    await expect(commit).resolves.toBe(true);
    await remount;
    expect(remountCursor).toBe(65536);

    releaseTerminalLog(sessionId);
  });
});
