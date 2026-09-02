import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalRuntimeStatus } from "../domain";

const write = vi.hoisted(() => vi.fn<() => Promise<void>>(async () => {}));

vi.mock("./sessionClient", () => ({
  sessionClient: { write },
}));

import { sendSessionInput, sessionAcceptsInput } from "./sessionInput";

const running: TerminalRuntimeStatus = {
  phase: "running",
  runId: 4,
  exitCode: null,
  termination: null,
  fault: null,
  observedAt: "2026-09-01T00:00:00.000Z",
};

beforeEach(() => {
  write.mockReset();
  write.mockResolvedValue();
});

describe("session input", () => {
  it("writes text as UTF-8 bytes to the running run only", async () => {
    await expect(sendSessionInput("s1", running, "한\r")).resolves.toBe(true);
    expect(write).toHaveBeenCalledWith("s1", 4, new TextEncoder().encode("한\r"));

    await expect(sendSessionInput("s1", { ...running, phase: "exited" }, "x")).resolves.toBe(false);
    await expect(sendSessionInput("s1", { ...running, runId: null }, "x")).resolves.toBe(false);
    await expect(sendSessionInput("s1", null, "x")).resolves.toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
    expect(sessionAcceptsInput(running)).toBe(true);
    expect(sessionAcceptsInput({ ...running, phase: "stopping" })).toBe(false);
  });

  it("keeps writes from different sources in order for one run", async () => {
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    write.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = () => {
            order.push("first");
            resolve();
          };
        }),
    );
    write.mockImplementationOnce(async () => {
      order.push("second");
    });

    const first = sendSessionInput("s1", running, "a");
    const second = sendSessionInput("s1", running, "b");
    // The queue hands the first write to the client a few microtasks later; give it a turn.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual([]);
    expect(releaseFirst).toBeDefined();
    releaseFirst?.();
    await first;
    await second;
    expect(order).toEqual(["first", "second"]);
  });

  it("reports a transport failure to the caller and resolves false", async () => {
    write.mockRejectedValueOnce(new Error("broker gone"));
    const failures: unknown[] = [];
    await expect(
      sendSessionInput("s1", running, "x", (cause) => failures.push(cause)),
    ).resolves.toBe(false);
    expect(failures.map((cause) => (cause as Error).message)).toEqual(["broker gone"]);
  });
});
