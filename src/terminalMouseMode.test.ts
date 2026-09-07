import { describe, expect, it } from "vitest";
import { RESET_INTERACTIVE_INPUT_MODES } from "./terminalInstances";
import {
  type MouseModeTerminal,
  type MouseTrackingMode,
  attachMouseMode,
  mouseTrackingSequence,
} from "./terminalMouseMode";

/** A terminal whose mouse mode follows the DECSET/DECRST it is written, like xterm's parser. */
function fakeTerminal(initial: MouseTrackingMode = "none") {
  let mode: MouseTrackingMode = initial;
  const handlers: { final: string; callback: (params: number[]) => boolean }[] = [];
  const written: string[] = [];
  const apply = (data: string) => {
    // Built from a char code so the lint rule against control characters in regex literals holds.
    const decMode = new RegExp(`${String.fromCharCode(27)}\\[\\?(\\d+)([hl])`, "g");
    for (const match of data.matchAll(decMode)) {
      const param = Number(match[1]);
      const final = match[2];
      for (const handler of handlers) if (handler.final === final) handler.callback([param]);
      if (final === "l" && [9, 1000, 1002, 1003].includes(param)) mode = "none";
      if (final === "h") {
        if (param === 9) mode = "x10";
        if (param === 1000) mode = "vt200";
        if (param === 1002) mode = "drag";
        if (param === 1003) mode = "any";
      }
    }
  };
  const terminal: MouseModeTerminal = {
    get modes() {
      return { mouseTrackingMode: mode };
    },
    write: (data) => {
      written.push(data);
      apply(data);
    },
    parser: {
      registerCsiHandler: (id, callback) => {
        const entry = { final: id.final, callback };
        handlers.push(entry);
        return { dispose: () => handlers.splice(handlers.indexOf(entry), 1) };
      },
    },
  };
  return { terminal, written, programWrites: apply };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("mouseTrackingSequence", () => {
  it("re-enables the mode a program had, with SGR encoding", () => {
    expect(mouseTrackingSequence("drag")).toBe("\x1b[?1002h\x1b[?1006h");
    expect(mouseTrackingSequence("none")).toBe("");
  });
});

describe("attachMouseMode", () => {
  it("follows the program's own requests and reports who holds the mouse", async () => {
    const { terminal, programWrites } = fakeTerminal();
    const owners: string[] = [];
    const handle = attachMouseMode(terminal, (owner) => owners.push(owner));
    expect(handle.owner).toBe("none");
    programWrites("\x1b[?1002h\x1b[?1006h");
    await flush();
    expect(handle.owner).toBe("program");
    programWrites("\x1b[?1002l");
    await flush();
    expect(owners).toEqual(["program", "none"]);
  });

  it("releases the mouse into the emulator only and hands the same mode back", async () => {
    const { terminal, written, programWrites } = fakeTerminal();
    const handle = attachMouseMode(terminal, () => undefined);
    programWrites("\x1b[?1003h");
    await flush();
    expect(handle.toggle()).toBe("released");
    expect(written).toEqual([RESET_INTERACTIVE_INPUT_MODES]);
    expect(terminal.modes.mouseTrackingMode).toBe("none");
    expect(handle.toggle()).toBe("program");
    expect(written.at(-1)).toBe("\x1b[?1003h\x1b[?1006h");
    expect(terminal.modes.mouseTrackingMode).toBe("any");
  });

  it("does nothing when no program holds the mouse", () => {
    const { terminal, written } = fakeTerminal();
    const handle = attachMouseMode(terminal, () => undefined);
    expect(handle.toggle()).toBe("none");
    expect(written).toEqual([]);
  });

  it("forgets the released mode once the program itself turns tracking back on", async () => {
    const { terminal, programWrites } = fakeTerminal("drag");
    const handle = attachMouseMode(terminal, () => undefined);
    expect(handle.owner).toBe("program");
    handle.toggle();
    programWrites("\x1b[?1000h");
    await flush();
    expect(handle.owner).toBe("program");
    expect(handle.toggle()).toBe("released");
  });
});
