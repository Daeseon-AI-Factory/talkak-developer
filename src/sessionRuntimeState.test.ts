import { describe, expect, it } from "vitest";
import { createWorkspaceSession } from "./sessionModel";
import { applyRuntimePhase } from "./sessionRuntimeState";

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

describe("session runtime state", () => {
  it("does not claim a runtime while it is only checking or starting", () => {
    expect(applyRuntimePhase(session, "checking")).toBe(session);
    expect(applyRuntimePhase(session, "starting")).toBe(session);
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
});
