import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import {
  partitionTerminalOutput,
  terminalRuntimePhase,
  terminalStreamEnabled,
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

  it("partitions a frame that straddles the replay boundary without copying", () => {
    const bytes = new TextEncoder().encode("abcdef");
    const [history, fresh] = partitionTerminalOutput(bytes, 100, 103);
    expect(new TextDecoder().decode(history?.bytes)).toBe("abc");
    expect(history?.suppressProtocolInput).toBe(true);
    expect(new TextDecoder().decode(fresh?.bytes)).toBe("def");
    expect(fresh?.suppressProtocolInput).toBe(false);
    expect(fresh?.bytes.buffer).toBe(bytes.buffer);
    expect(partitionTerminalOutput(bytes, 100, 100)).toEqual([
      { bytes, suppressProtocolInput: false },
    ]);
    expect(partitionTerminalOutput(bytes, 100, 900)).toEqual([
      { bytes, suppressProtocolInput: true },
    ]);
    expect(partitionTerminalOutput(new Uint8Array(0), 0, 0)).toEqual([]);
  });

  it("streams exited foreground sessions without keeping exited background emulators alive", () => {
    expect(terminalStreamEnabled("running", true)).toBe(true);
    expect(terminalStreamEnabled("stopping", true)).toBe(true);
    expect(terminalStreamEnabled("exited", false)).toBe(true);
    expect(terminalStreamEnabled("exited", true)).toBe(false);
    expect(terminalStreamEnabled("idle", false)).toBe(false);
  });

  it("separates process exit from output-reader drain completion", () => {
    expect(terminalRuntimePhase("running", false, null)).toBe("exited");
    expect(terminalRuntimePhase("stopping", false, null)).toBe("exited");
    expect(terminalRuntimePhase("stopping", true, null)).toBe("stopping");
    expect(terminalRuntimePhase("running", true, "reader failed")).toBe("error");
  });
});
