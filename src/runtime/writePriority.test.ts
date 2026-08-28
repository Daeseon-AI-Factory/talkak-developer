import { afterEach, describe, expect, it } from "vitest";
import {
  awaitWriteIdle,
  resetWritePriority,
  withWritePriority,
  writeInFlight,
} from "./writePriority";

afterEach(resetWritePriority);

describe("writes outrank reads", () => {
  it("lets a poll through immediately when nothing is being written", async () => {
    let passed = false;
    await awaitWriteIdle().then(() => {
      passed = true;
    });
    expect(passed).toBe(true);
  });

  it("holds a poll until the write finishes", async () => {
    let released = false;
    let finishWrite: (() => void) | undefined;
    const write = withWritePriority(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        }),
    );
    void awaitWriteIdle().then(() => {
      released = true;
    });

    await Promise.resolve();
    expect(writeInFlight()).toBe(true);
    expect(released).toBe(false);

    finishWrite?.();
    await write;
    await Promise.resolve();
    expect(released).toBe(true);
  });

  it("releases polls even when the write fails, so a failure cannot wedge the loop", async () => {
    let released = false;
    void awaitWriteIdle().then(() => {
      released = true;
    });
    await expect(
      withWritePriority(() => Promise.reject(new Error("broker closed"))),
    ).rejects.toThrow("broker closed");
    await Promise.resolve();
    expect(writeInFlight()).toBe(false);
    expect(released).toBe(true);
  });

  it("keeps polls waiting until the LAST of several writes lands", async () => {
    let released = false;
    let finishFirst: (() => void) | undefined;
    let finishSecond: (() => void) | undefined;
    const first = withWritePriority(() => new Promise<void>((resolve) => (finishFirst = resolve)));
    const second = withWritePriority(
      () => new Promise<void>((resolve) => (finishSecond = resolve)),
    );
    void awaitWriteIdle().then(() => {
      released = true;
    });

    finishFirst?.();
    await first;
    await Promise.resolve();
    expect(released).toBe(false);

    finishSecond?.();
    await second;
    await Promise.resolve();
    expect(released).toBe(true);
  });
});
