import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";

interface Snap {
  ybase: number;
  ydisp: number;
  length: number;
  viewport: string[];
}

function snap(t: Terminal): Snap {
  // biome-ignore lint: probe
  const core = (t as any)._core;
  const buf = core.buffer;
  const viewport: string[] = [];
  for (let i = 0; i < t.rows; i++) {
    const line = buf.lines.get(buf.ydisp + i);
    viewport.push(line ? line.translateToString(true) : "<none>");
  }
  return { ybase: buf.ybase, ydisp: buf.ydisp, length: buf.lines.length, viewport };
}

async function build(opts: Record<string, unknown>): Promise<Terminal> {
  const t = new Terminal({ cols: 40, rows: 10, scrollback: 5000, ...opts });
  let out = "";
  for (let i = 1; i <= 30; i++) out += `line-${i}\r\n`;
  out += "PROMPT>";
  await new Promise<void>((r) => t.write(out, r));
  return t;
}

describe("row-growth heuristic", () => {
  it("default options (what SessionTerminal.tsx ships)", async () => {
    const t = await build({});
    const before = snap(t);
    t.resize(40, 14);
    const after = snap(t);
    console.log("DEFAULT before", JSON.stringify(before, null, 1));
    console.log("DEFAULT after ", JSON.stringify(after, null, 1));
    expect(before).toBeTruthy();
    t.dispose();
  });

  it("windowsPty conpty build 26100", async () => {
    const t = await build({ windowsPty: { backend: "conpty", buildNumber: 26100 } });
    const before = snap(t);
    t.resize(40, 14);
    const after = snap(t);
    console.log("CONPTY before", JSON.stringify(before, null, 1));
    console.log("CONPTY after ", JSON.stringify(after, null, 1));
    expect(after).toBeTruthy();
    t.dispose();
  });

  it("reflow toggle by buildNumber", async () => {
    for (const bn of [0, 19041, 21376, 26100]) {
      const t = new Terminal({
        cols: 40,
        rows: 10,
        scrollback: 5000,
        windowsPty: { backend: "conpty", buildNumber: bn },
      });
      // biome-ignore lint: probe
      const core = (t as any)._core;
      console.log(`buildNumber=${bn} reflowEnabled=${core.buffers.normal._isReflowEnabled}`);
      t.dispose();
    }
    expect(true).toBe(true);
  });
});
