import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import {
  FULL_READ_CHUNK_BYTES,
  nextReadDelayMs,
  partitionTerminalOutput,
  terminalOutputDrained,
  terminalPollingEnabled,
  terminalReadShouldContinue,
  terminalRuntimePhase,
} from "./terminalReplay";

describe("xterm protocol handling", () => {
  it("answers a cursor-position query with the emulator's actual cursor", async () => {
    const terminal = new Terminal({ cols: 80, rows: 24 });
    const replies: string[] = [];
    const input = terminal.onData((data) => replies.push(data));

    await new Promise<void>((resolve) => terminal.write("\x1b[5;10H\x1b[6n", resolve));

    expect(replies).toEqual(["\x1b[5;10R"]);
    input.dispose();
    terminal.dispose();
  });

  it("suppresses replay side effects and answers only new protocol queries", async () => {
    const terminal = new Terminal({ cols: 80, rows: 24 });
    const replies: string[] = [];
    let suppressProtocolInput = false;
    const input = terminal.onData((data) => {
      if (!suppressProtocolInput) replies.push(data);
    });
    const replay = new TextEncoder().encode("\x1b[2;3H\x1b[6n");
    const current = new TextEncoder().encode("\x1b[7;11H\x1b[6n");
    const bytes = new Uint8Array([...replay, ...current]);

    for (const chunk of partitionTerminalOutput(bytes, 0, replay.length)) {
      suppressProtocolInput = chunk.suppressProtocolInput;
      await new Promise<void>((resolve) => terminal.write(chunk.bytes, resolve));
    }
    suppressProtocolInput = false;

    expect(replies).toEqual(["\x1b[7;11R"]);
    input.dispose();
    terminal.dispose();
  });

  it("replays exited foreground sessions without keeping exited background emulators alive", () => {
    expect(terminalPollingEnabled("running", true)).toBe(true);
    expect(terminalPollingEnabled("stopping", true)).toBe(true);
    expect(terminalPollingEnabled("exited", false)).toBe(true);
    expect(terminalPollingEnabled("exited", true)).toBe(false);
    expect(terminalPollingEnabled("idle", false)).toBe(false);
  });

  it("separates process exit from output-reader drain completion", () => {
    expect(terminalRuntimePhase("running", false, null)).toBe("exited");
    expect(terminalRuntimePhase("stopping", false, null)).toBe("exited");
    expect(terminalRuntimePhase("stopping", true, null)).toBe("stopping");
    expect(terminalRuntimePhase("running", true, "reader failed")).toBe("error");

    expect(terminalReadShouldContinue(false, false, 0)).toBe(true);
    expect(terminalReadShouldContinue(false, true, 1)).toBe(true);
    expect(terminalReadShouldContinue(false, true, 0)).toBe(false);
    expect(terminalReadShouldContinue(true, false, 0)).toBe(true);
    expect(terminalOutputDrained(false, 0)).toBe(true);
    expect(terminalOutputDrained(false, 1)).toBe(false);
    expect(terminalOutputDrained(true, 0)).toBe(false);
  });
});

describe("read pacing", () => {
  it("drains a backlog at RPC pace: a full chunk means the buffer holds more", () => {
    expect(nextReadDelayMs(true, FULL_READ_CHUNK_BYTES, 75)).toBe(0);
    expect(nextReadDelayMs(true, FULL_READ_CHUNK_BYTES + 1, 75)).toBe(0);
  });

  it("returns to poll pace once caught up on a live session", () => {
    expect(nextReadDelayMs(true, 120, 75)).toBe(75);
    expect(nextReadDelayMs(true, 0, 75)).toBe(75);
  });

  it("keeps draining a finished session immediately while bytes remain", () => {
    expect(nextReadDelayMs(false, 120, 75)).toBe(0);
    expect(nextReadDelayMs(false, 0, 75)).toBe(75);
  });
});
