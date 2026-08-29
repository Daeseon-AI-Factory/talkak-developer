import { afterEach, describe, expect, it, vi } from "vitest";
import {
  awaitWriteIdle,
  resetWritePriority,
  withWritePriority,
  writeInFlight,
} from "./writePriority";

afterEach(() => {
  resetWritePriority();
  vi.useRealTimers();
});

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
    const first = withWritePriority(
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve;
        }),
    );
    const second = withWritePriority(
      () =>
        new Promise<void>((resolve) => {
          finishSecond = resolve;
        }),
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

describe("a stuck write cannot silence the app", () => {
  it("lets a poll go anyway once the deferral bound passes", async () => {
    vi.useFakeTimers();
    let released = false;
    // A write that never comes back: on Windows the broker pipe has no read timeout, so this is
    // not hypothetical.
    void withWritePriority(() => new Promise<void>(() => {}));
    void awaitWriteIdle().then(() => {
      released = true;
    });

    await Promise.resolve();
    expect(released).toBe(false);

    await vi.advanceTimersByTimeAsync(250);
    expect(released).toBe(true);
    // The write is still outstanding — the poll was let past, not lied to.
    expect(writeInFlight()).toBe(true);
  });

  it("does not hold back a different session's polls", async () => {
    let otherReleased = false;
    void withWritePriority(() => new Promise<void>(() => {}), "session-a");
    void awaitWriteIdle("session-b").then(() => {
      otherReleased = true;
    });

    await Promise.resolve();
    expect(otherReleased).toBe(true);
    expect(writeInFlight("session-a")).toBe(true);
    expect(writeInFlight("session-b")).toBe(false);
  });

  it("survives a reset taken while a write is in flight", async () => {
    // The counter used to go negative here, after which the "=== 0" release could never fire and
    // every later poll waited forever.
    let finish: (() => void) | undefined;
    const write = withWritePriority(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    resetWritePriority();
    finish?.();
    await write;

    expect(writeInFlight()).toBe(false);
    let released = false;
    await awaitWriteIdle().then(() => {
      released = true;
    });
    expect(released).toBe(true);
  });
});
