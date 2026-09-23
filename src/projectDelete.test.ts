import { describe, expect, it } from "vitest";
import type { DevSession, Project, TerminalRuntimeStatus } from "./domain";
import { neighbourProjectId, projectDeleteImpact } from "./projectDelete";
import { createLocalProject } from "./projectStore";
import { createWorkspaceSession } from "./sessionModel";

function session(id: string, phase: TerminalRuntimeStatus["phase"] | null): DevSession {
  const base = createWorkspaceSession({
    id,
    title: id,
    profile: "Agent",
    launchProfile: { label: "Agent", command: null, args: [] },
    branch: "main",
    createdAt: "2026-09-01T00:00:00.000Z",
    lastActivity: "now",
    intro: null,
    outcome: "done",
    nextStep: "next",
    launchRequested: false,
  });
  return phase === null
    ? base
    : {
        ...base,
        runtimeStatus: {
          phase,
          runId: 1,
          exitCode: null,
          termination: null,
          fault: null,
          observedAt: "2026-09-01T00:00:00.000Z",
        },
      };
}

function project(id: string, sessions: DevSession[] = []): Project {
  return {
    ...createLocalProject(
      {
        name: id,
        description: "",
        path: `/p/${id}`,
        launchProfile: { label: "", command: null, args: [] },
      },
      id,
    ),
    sessions,
  };
}

describe("project delete impact", () => {
  it("counts sessions and the ones still working", () => {
    expect(
      projectDeleteImpact(
        project("p", [
          session("a", "running"),
          session("b", "starting"),
          session("c", "exited"),
          session("d", null),
        ]),
      ),
    ).toEqual({ sessions: 4, running: 2 });
    expect(projectDeleteImpact(project("empty"))).toEqual({ sessions: 0, running: 0 });
  });

  it("lands on the next project down, else the one above, else nowhere", () => {
    const projects = [project("a"), project("b"), project("c")];
    expect(neighbourProjectId(projects, "a")).toBe("b");
    expect(neighbourProjectId(projects, "b")).toBe("c");
    expect(neighbourProjectId(projects, "c")).toBe("b");
    expect(neighbourProjectId([project("only")], "only")).toBeNull();
    expect(neighbourProjectId(projects, "missing")).toBeNull();
  });
});
