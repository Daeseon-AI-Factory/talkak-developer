import { describe, expect, it } from "vitest";
import { projects } from "./demo";
import {
  countSessions,
  firstSession,
  nextGeneratedPageTitle,
  runtimeLabel,
} from "./workspaceModel";

describe("workspace model", () => {
  it("counts only actionable session states", () => {
    expect(countSessions(projects[0].sessions)).toEqual({
      working: 1,
      needsInput: 1,
      ready: 0,
      starting: 0,
      running: 0,
      stopping: 0,
      exited: 0,
      errors: 0,
    });
  });

  it("counts observed PTY phases and faults without inferring task outcomes", () => {
    const base = projects[0].sessions[0];
    const observedAt = "2026-08-14T01:00:00.000Z";
    const sessions = [
      {
        ...base,
        id: "starting",
        runtimeStatus: {
          phase: "starting" as const,
          runId: null,
          exitCode: null,
          termination: null,
          fault: null,
          observedAt,
        },
      },
      {
        ...base,
        id: "running-error",
        runtimeStatus: {
          phase: "running" as const,
          runId: 1,
          exitCode: null,
          termination: null,
          fault: { operation: "write" as const, message: "broken pipe" },
          observedAt,
        },
      },
      {
        ...base,
        id: "stopping",
        runtimeStatus: {
          phase: "stopping" as const,
          runId: 2,
          exitCode: null,
          termination: "requested-stop" as const,
          fault: null,
          observedAt,
        },
      },
      {
        ...base,
        id: "exited",
        runtimeStatus: {
          phase: "exited" as const,
          runId: 3,
          exitCode: 7,
          termination: "observed-exit" as const,
          fault: null,
          observedAt,
        },
      },
    ];

    expect(countSessions(sessions)).toMatchObject({
      starting: 1,
      running: 1,
      stopping: 1,
      exited: 1,
      errors: 1,
    });
  });

  it("keeps WSL as a Windows session target", () => {
    const wslSession = projects[1].sessions[0];
    if (wslSession.runtime.kind !== "wsl") throw new Error("Expected the fixture to use WSL");
    expect(wslSession.runtime.os).toBe("windows");
    expect(runtimeLabel(wslSession)).toBe("WSL · Ubuntu");
  });

  it("provides an explicit empty fallback", () => {
    expect(firstSession({ ...projects[0], sessions: [] })).toBeNull();
  });

  it("labels a connected provider-neutral local PTY", () => {
    const session = {
      ...projects[0].sessions[0],
      runtime: { kind: "local" as const, label: "Review agent", shell: "PTY" },
    };
    expect(runtimeLabel(session)).toBe("Review agent");
  });

  it("does not reuse a generated page number after a middle page is closed", () => {
    expect(
      nextGeneratedPageTitle([
        { id: "page-1", title: { kind: "page-title", index: 1 }, root: null },
        { id: "page-3", title: { kind: "page-title", index: 3 }, root: null },
      ]),
    ).toEqual({ kind: "page-title", index: 4 });
  });
});
