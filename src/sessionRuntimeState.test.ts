import { describe, expect, it } from "vitest";
import type { TerminalRuntimeObservation, TerminalRuntimePhase } from "./domain";
import { createWorkspaceSession } from "./sessionModel";
import {
  applyRuntimeObservation,
  applyRuntimeObservationToProjects,
  applyRuntimePhase,
  shouldApplyRuntimeObservation,
} from "./sessionRuntimeState";

const session = createWorkspaceSession({
  id: "session-1",
  title: "Session 1",
  profile: "Default terminal",
  launchProfile: { label: "Local shell", command: null, args: [] },
  branch: "—",
  createdAt: "2026-08-10T00:00:00.000Z",
  lastActivity: "Created now",
  intro: "",
  outcome: "",
  nextStep: "",
  launchRequested: false,
});

function runtimeObservation(
  phase: TerminalRuntimePhase,
  runId: number | null,
  overrides: Partial<Omit<TerminalRuntimeObservation, "phase" | "runId">> = {},
): TerminalRuntimeObservation {
  return {
    origin: "runtime-event",
    phase,
    runId,
    exitCode: phase === "exited" ? 0 : null,
    termination: phase === "exited" ? "observed-exit" : null,
    fault: phase === "error" ? { operation: "read", message: "runtime failed" } : null,
    observedAt: "2026-08-14T02:00:00.000Z",
    ...overrides,
  };
}

describe("session runtime state", () => {
  it("does not fabricate observations in the legacy phase-only bridge", () => {
    expect(applyRuntimePhase(session, "checking")).toBe(session);
    expect(applyRuntimePhase(session, "starting")).toBe(session);
    expect(session.runtimeStatus).toBeNull();
  });

  it("marks an attached PTY as working with its configured runtime", () => {
    const running = applyRuntimePhase(session, "running");

    expect(running.state).toBe("working");
    expect(running.runtime).toEqual({ kind: "local", label: "Local shell", shell: "PTY" });
  });

  it("keeps the attached runtime identity after the PTY exits", () => {
    const running = applyRuntimePhase(session, "running");
    const exited = applyRuntimePhase(running, "exited");

    expect(exited.state).toBe("idle");
    expect(exited.runtime).toBe(running.runtime);
  });

  it("records an attached runtime without replacing summary or conversation data", () => {
    const observation: TerminalRuntimeObservation = {
      origin: "runtime-event",
      phase: "running",
      runId: 7,
      exitCode: null,
      termination: null,
      fault: null,
      observedAt: "2026-08-14T01:00:00.000Z",
    };

    const running = applyRuntimeObservation(session, observation);

    expect(running.state).toBe(session.state);
    expect(running.runtime).toEqual({ kind: "local", label: "Local shell", shell: "PTY" });
    expect(running.runtimeStatus).toEqual({
      phase: "running",
      runId: 7,
      exitCode: null,
      termination: null,
      fault: null,
      observedAt: "2026-08-14T01:00:00.000Z",
    });
    expect(running.summary).toBe(session.summary);
    expect(running.conversation).toBe(session.conversation);
  });

  it("keeps the same session and original time when only observedAt changes", () => {
    const observation: TerminalRuntimeObservation = {
      origin: "runtime-event",
      phase: "error",
      runId: 7,
      exitCode: null,
      termination: null,
      fault: { operation: "read", message: "stream closed" },
      observedAt: "2026-08-14T01:01:00.000Z",
    };
    const failed = applyRuntimeObservation(session, observation);

    expect(
      applyRuntimeObservation(failed, {
        ...observation,
        fault: { operation: "read", message: "stream closed" },
        observedAt: "2026-08-14T01:01:10.000Z",
      }),
    ).toBe(failed);
    expect(failed.runtimeStatus?.observedAt).toBe("2026-08-14T01:01:00.000Z");
  });

  it("keeps the projects array stable when a poll has no substantive change", () => {
    const projects = [
      {
        id: "project-1",
        source: "local" as const,
        name: "Project",
        monogram: "P",
        color: "#000",
        path: "/project",
        branch: "—",
        description: "",
        launchProfile: session.launchProfile,
        sessions: [session],
      },
    ];
    const observation: TerminalRuntimeObservation = {
      origin: "runtime-event",
      phase: "running",
      runId: 7,
      exitCode: null,
      termination: null,
      fault: null,
      observedAt: "2026-08-14T01:01:00.000Z",
    };
    const running = applyRuntimeObservationToProjects(projects, session.id, observation);
    const unchanged = applyRuntimeObservationToProjects(running, session.id, {
      ...observation,
      observedAt: "2026-08-14T01:01:10.000Z",
    });

    expect(running).not.toBe(projects);
    expect(unchanged).toBe(running);
  });

  it("rejects a lower non-null run ID while accepting a newer run", () => {
    const current = applyRuntimeObservation(session, runtimeObservation("running", 10));
    const lower = runtimeObservation("exited", 9);
    const higher = runtimeObservation("running", 11);

    expect(shouldApplyRuntimeObservation(current.runtimeStatus ?? null, lower)).toBe(false);
    expect(applyRuntimeObservation(current, lower)).toBe(current);
    expect(shouldApplyRuntimeObservation(current.runtimeStatus ?? null, higher)).toBe(true);

    const newer = applyRuntimeObservation(current, higher);
    expect(newer).not.toBe(current);
    expect(newer.runtimeStatus).toMatchObject({ phase: "running", runId: 11 });
  });

  it.each([
    ["exited", "starting"],
    ["exited", "running"],
    ["exited", "stopping"],
    ["error", "starting"],
    ["error", "running"],
    ["error", "stopping"],
  ] as const)("rejects a same-run %s to %s regression", (currentPhase, nextPhase) => {
    const current = applyRuntimeObservation(session, runtimeObservation(currentPhase, 10));
    const regressed = runtimeObservation(nextPhase, 10);

    expect(shouldApplyRuntimeObservation(current.runtimeStatus ?? null, regressed)).toBe(false);
    expect(applyRuntimeObservation(current, regressed)).toBe(current);
  });

  it.each(["exited", "error"] as const)("accepts a newer running run after %s", (currentPhase) => {
    const current = applyRuntimeObservation(session, runtimeObservation(currentPhase, 10));
    const observation = runtimeObservation("running", 11);
    const newer = applyRuntimeObservation(current, observation);

    expect(shouldApplyRuntimeObservation(current.runtimeStatus ?? null, observation)).toBe(true);
    expect(newer).not.toBe(current);
    expect(newer.runtimeStatus).toMatchObject({ phase: "running", runId: 11 });
  });

  it.each(["starting", "running"] as const)(
    "rejects a same-run stopping to %s regression",
    (nextPhase) => {
      const stopping = applyRuntimeObservation(session, runtimeObservation("stopping", 10));
      const regressed = runtimeObservation(nextPhase, 10);

      expect(shouldApplyRuntimeObservation(stopping.runtimeStatus ?? null, regressed)).toBe(false);
      expect(applyRuntimeObservation(stopping, regressed)).toBe(stopping);
    },
  );

  it("accepts a same-run exit after stopping", () => {
    const stopping = applyRuntimeObservation(session, runtimeObservation("stopping", 10));
    const observation = runtimeObservation("exited", 10);
    const exited = applyRuntimeObservation(stopping, observation);

    expect(shouldApplyRuntimeObservation(stopping.runtimeStatus ?? null, observation)).toBe(true);
    expect(exited).not.toBe(stopping);
    expect(exited.runtimeStatus).toMatchObject({ phase: "exited", runId: 10 });
  });

  it.each(["write", "resize"] as const)(
    "keeps a non-fatal %s fault alongside a running phase",
    (operation) => {
      const running = applyRuntimeObservation(session, {
        origin: "runtime-event",
        phase: "running",
        runId: 7,
        exitCode: null,
        termination: null,
        fault: { operation, message: `${operation} failed` },
        observedAt: "2026-08-14T01:01:30.000Z",
      });

      expect(running.state).toBe(session.state);
      expect(running.runtimeStatus).toMatchObject({
        phase: "running",
        runId: 7,
        fault: { operation, message: `${operation} failed` },
      });
    },
  );

  it.each(["checking", "idle", "unavailable"] as const)(
    "does not clear an error with a passive %s probe",
    (phase) => {
      const failed = applyRuntimeObservation(session, {
        origin: "runtime-event",
        phase: "error",
        runId: 7,
        exitCode: null,
        termination: null,
        fault: { operation: "read", message: "stream closed" },
        observedAt: "2026-08-14T01:02:00.000Z",
      });
      const probe: TerminalRuntimeObservation = {
        origin: "passive-probe",
        phase,
        runId: null,
        exitCode: null,
        termination: null,
        fault: null,
        observedAt: "2026-08-14T01:03:00.000Z",
      };

      expect(shouldApplyRuntimeObservation(failed.runtimeStatus ?? null, probe)).toBe(false);
      expect(applyRuntimeObservation(failed, probe)).toBe(failed);
    },
  );

  it.each(["idle", "running", "error"] as const)(
    "keeps needs-input while a passive observation reports %s",
    (phase) => {
      const needsInput = { ...session, state: "needs-input" as const };
      const observed = applyRuntimeObservation(
        needsInput,
        runtimeObservation(phase, phase === "idle" ? null : 12, {
          origin: "passive-probe",
        }),
      );

      expect(observed.runtimeStatus?.phase).toBe(phase);
      expect(observed.state).toBe("needs-input");
    },
  );

  it("keeps an observed exit through a passive empty probe", () => {
    const exited = applyRuntimeObservation(session, {
      origin: "runtime-event",
      phase: "exited",
      runId: 8,
      exitCode: 0,
      termination: "observed-exit",
      fault: null,
      observedAt: "2026-08-14T01:04:00.000Z",
    });

    const probed = applyRuntimeObservation(exited, {
      origin: "passive-probe",
      phase: "idle",
      runId: null,
      exitCode: null,
      termination: null,
      fault: null,
      observedAt: "2026-08-14T01:05:00.000Z",
    });

    expect(probed).toBe(exited);
    expect(probed.runtimeStatus).toMatchObject({
      phase: "exited",
      runId: 8,
      exitCode: 0,
      termination: "observed-exit",
    });
  });

  it.each(["exited", "error", "stopping"] as const)(
    "allows an explicit start after %s and clears the previous run",
    (currentPhase) => {
      const current = applyRuntimeObservation(session, runtimeObservation(currentPhase, 9));
      const explicitStart: TerminalRuntimeObservation = {
        ...runtimeObservation("starting", 8),
        origin: "explicit-action",
        exitCode: 1,
        termination: "observed-exit",
        fault: { operation: "start", message: "stale failure" },
        observedAt: "2026-08-14T02:01:00.000Z",
      };
      const starting = applyRuntimeObservation(current, explicitStart);

      expect(shouldApplyRuntimeObservation(current.runtimeStatus ?? null, explicitStart)).toBe(
        true,
      );
      expect(starting).not.toBe(current);
      expect(starting.state).toBe(current.state);
      expect(starting.runtimeStatus).toEqual({
        phase: "starting",
        runId: null,
        exitCode: null,
        termination: null,
        fault: null,
        observedAt: "2026-08-14T02:01:00.000Z",
      });
    },
  );
});
