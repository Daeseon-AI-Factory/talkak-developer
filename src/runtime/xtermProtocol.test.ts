import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import { partitionTerminalOutput } from "./terminalReplay";

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
});
