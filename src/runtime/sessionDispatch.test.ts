import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalRuntimeObservation, TerminalRuntimeStatus } from "../domain";

const write = vi.hoisted(() => vi.fn<() => Promise<void>>(async () => {}));

vi.mock("./sessionClient", () => ({
  sessionClient: { write },
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import { typeIntoSession } from "./sessionDispatch";

const running: TerminalRuntimeStatus = {
  phase: "running",
  runId: 7,
  exitCode: null,
  termination: null,
  fault: null,
  observedAt: "2026-09-01T00:00:00.000Z",
};

beforeEach(() => {
  write.mockReset();
  write.mockResolvedValue();
});

describe("typing into a session from outside its pane", () => {
  it("writes the line as typed, with no Enter, and moves focus to the pane", async () => {
    const focused: string[] = [];
    const reports: TerminalRuntimeObservation[] = [];
    await expect(
      typeIntoSession(
        { id: "s1", runtimeStatus: running },
        "git status",
        (_, observation) => reports.push(observation),
        (sessionId) => focused.push(sessionId),
      ),
    ).resolves.toBe(true);
    expect(write).toHaveBeenCalledWith("s1", 7, new TextEncoder().encode("git status"));
    expect(focused).toEqual(["s1"]);
    expect(reports).toEqual([]);
  });

  it("sends nothing to a session that is not running", async () => {
    const focused: string[] = [];
    await expect(
      typeIntoSession(
        { id: "s1", runtimeStatus: { ...running, phase: "exited" } },
        "ls",
        () => undefined,
        (sessionId) => focused.push(sessionId),
      ),
    ).resolves.toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(focused).toEqual(["s1"]);
  });

  it("reports a transport failure as a write fault on the session", async () => {
    write.mockRejectedValueOnce(new Error("broker gone"));
    const reports: Array<[string, TerminalRuntimeObservation]> = [];
    await expect(
      typeIntoSession(
        { id: "s1", runtimeStatus: running },
        "ls",
        (sessionId, observation) => reports.push([sessionId, observation]),
        () => undefined,
      ),
    ).resolves.toBe(false);
    expect(reports).toHaveLength(1);
    const [sessionId, observation] = reports[0];
    expect(sessionId).toBe("s1");
    expect(observation.phase).toBe("running");
    expect(observation.runId).toBe(7);
    expect(observation.origin).toBe("runtime-event");
    expect(observation.fault).toEqual({ operation: "write", message: "broker gone" });
  });
});
