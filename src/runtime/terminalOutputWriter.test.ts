import { describe, expect, it } from "vitest";
import { createTerminalOutputWriter } from "./terminalOutputWriter";

describe("terminal output writer", () => {
  it("lets an xterm write already submitted at detach finish and rejects the queued tail", async () => {
    const submitted: Array<{ text: string; done: () => void }> = [];
    const writer = createTerminalOutputWriter(
      (bytes, done) => submitted.push({ text: new TextDecoder().decode(bytes), done }),
      () => {},
    );

    const first = writer.write(new TextEncoder().encode("first"), true);
    const second = writer.write(new TextEncoder().encode("second"), false);
    await Promise.resolve();
    expect(submitted.map(({ text }) => text)).toEqual(["first"]);

    writer.dispose();
    submitted[0].done();

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
    expect(submitted.map(({ text }) => text)).toEqual(["first"]);
  });

  it("holds protocol suppression until each chunk has actually been parsed", async () => {
    const callbacks: Array<() => void> = [];
    const suppression: boolean[] = [];
    const writer = createTerminalOutputWriter(
      (_bytes, done) => callbacks.push(done),
      (suppressed) => suppression.push(suppressed),
    );

    const replay = writer.write(new Uint8Array([1]), true);
    const live = writer.write(new Uint8Array([2]), false);
    await Promise.resolve();
    expect(callbacks).toHaveLength(1);
    expect(suppression).toEqual([true]);

    callbacks[0]();
    await replay;
    await Promise.resolve();
    expect(callbacks).toHaveLength(2);
    expect(suppression).toEqual([true, false, false]);

    callbacks[1]();
    await expect(live).resolves.toBe(true);
  });

  it("reports a real xterm write failure and keeps the following write usable", async () => {
    let attempts = 0;
    let finishSecond = () => {};
    const writer = createTerminalOutputWriter(
      (_bytes, done) => {
        attempts += 1;
        if (attempts === 1) throw new Error("xterm rejected output");
        finishSecond = done;
      },
      () => {},
    );

    await expect(writer.write(new Uint8Array([1]), false)).rejects.toThrow("xterm rejected output");
    const second = writer.write(new Uint8Array([2]), false);
    await Promise.resolve();
    finishSecond();

    await expect(second).resolves.toBe(true);
    expect(attempts).toBe(2);
  });
});
