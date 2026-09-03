import { describe, expect, it } from "vitest";
import type { TerminalRuntimeStatus } from "../domain";
import {
  beginRuntimeOperation,
  createRuntimeMutationQueue,
  createRuntimeOperationTracker,
  enqueueRuntimeMutation,
  invalidateRuntimeOperations,
  runtimeOperationBelongsToCurrentRuntime,
  runtimeOperationIsCurrent,
} from "./runtimeOperationGuard";

const running: TerminalRuntimeStatus = {
  phase: "running",
  runId: 3,
  exitCode: null,
  termination: null,
  fault: null,
  observedAt: "2026-08-14T01:00:00.000Z",
};

describe("runtime operation guard", () => {
  it("accepts only the latest request for the same operation", () => {
    const tracker = createRuntimeOperationTracker();
    const first = beginRuntimeOperation(tracker, "write", running);
    const second = beginRuntimeOperation(tracker, "write", running);

    expect(runtimeOperationIsCurrent(tracker, first, running)).toBe(false);
    expect(runtimeOperationIsCurrent(tracker, second, running)).toBe(true);
    expect(runtimeOperationBelongsToCurrentRuntime(tracker, first, running)).toBe(true);
  });

  it("tracks writes and resizes independently", () => {
    const tracker = createRuntimeOperationTracker();
    const write = beginRuntimeOperation(tracker, "write", running);
    beginRuntimeOperation(tracker, "resize", running);

    expect(runtimeOperationIsCurrent(tracker, write, running)).toBe(true);
  });

  it("rejects completion after the run or phase changes", () => {
    const tracker = createRuntimeOperationTracker();
    const token = beginRuntimeOperation(tracker, "write", running);

    expect(runtimeOperationIsCurrent(tracker, token, { ...running, runId: 4 })).toBe(false);
    expect(runtimeOperationIsCurrent(tracker, token, { ...running, phase: "exited" })).toBe(false);
  });

  it("rejects completion after lifecycle invalidation", () => {
    const tracker = createRuntimeOperationTracker();
    const token = beginRuntimeOperation(tracker, "resize", running);

    invalidateRuntimeOperations(tracker);

    expect(runtimeOperationIsCurrent(tracker, token, running)).toBe(false);
  });

  it("serializes terminal writes in input order", async () => {
    const queue = createRuntimeMutationQueue();
    const order: string[] = [];
    let releaseFirst = () => {};
    let markFirstStarted = () => {};
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    void enqueueRuntimeMutation(
      queue,
      "session-1:3:write",
      () => {
        order.push("first");
        markFirstStarted();
        return firstPending;
      },
      () => {},
    );
    const second = enqueueRuntimeMutation(
      queue,
      "session-1:3:write",
      async () => {
        order.push("second");
      },
      () => {},
    );

    await firstStarted;
    expect(order).toEqual(["first"]);
    releaseFirst();
    await second;
    expect(order).toEqual(["first", "second"]);
  });

  it("reports a failed write and continues the FIFO", async () => {
    const queue = createRuntimeMutationQueue();
    const failures: unknown[] = [];
    const order: string[] = [];
    void enqueueRuntimeMutation(
      queue,
      "session-1:3:write",
      async () => {
        order.push("first");
        throw new Error("write failed");
      },
      (cause) => failures.push(cause),
    );
    const second = enqueueRuntimeMutation(
      queue,
      "session-1:3:write",
      async () => {
        order.push("second");
      },
      (cause) => failures.push(cause),
    );

    await second;

    expect(order).toEqual(["first", "second"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(Error);
  });

  it("serializes resizes across callers that share a runtime key", async () => {
    const queue = createRuntimeMutationQueue();
    const order: string[] = [];
    let releaseFirst = () => {};
    let markFirstStarted = () => {};
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    void enqueueRuntimeMutation(
      queue,
      "session-1:3:resize",
      () => {
        order.push("80x24");
        markFirstStarted();
        return firstPending;
      },
      () => {},
    );
    const latest = enqueueRuntimeMutation(
      queue,
      "session-1:3:resize",
      async () => {
        order.push("120x40");
      },
      () => {},
    );

    await firstStarted;
    expect(order).toEqual(["80x24"]);
    releaseFirst();
    await latest;
    expect(order).toEqual(["80x24", "120x40"]);
    expect(queue.pending.size).toBe(0);
  });
});
