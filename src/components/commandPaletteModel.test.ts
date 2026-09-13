import { describe, expect, it } from "vitest";
import type { DevSession, Project, TerminalRuntimeStatus } from "../domain";
import { createLocalProject } from "../projectStore";
import { createWorkspaceSession } from "../sessionModel";
import { dispatchText, paletteModel } from "./commandPaletteModel";

const running: TerminalRuntimeStatus = {
  phase: "running",
  runId: 3,
  exitCode: null,
  termination: null,
  fault: null,
  observedAt: "2026-09-01T00:00:00.000Z",
};

function session(id: string, title: string, runtimeStatus: TerminalRuntimeStatus | null) {
  return {
    ...createWorkspaceSession({
      id,
      title,
      profile: "Agent",
      launchProfile: { label: "Agent", command: "agent-cli", args: [] },
      branch: "main",
      createdAt: "2026-09-01T00:00:00.000Z",
      lastActivity: "now",
      intro: null,
      outcome: "done",
      nextStep: "next",
      launchRequested: false,
    }),
    runtimeStatus,
  } satisfies DevSession;
}

function project(id: string, name: string, sessions: DevSession[]): Project {
  return {
    ...createLocalProject(
      {
        name,
        description: "",
        path: `/p/${id}`,
        launchProfile: { label: "", command: null, args: [] },
      },
      id,
    ),
    sessions,
  };
}

const text = (value: string | { kind: string }) => (typeof value === "string" ? value : value.kind);

describe("command palette model", () => {
  const build = session("s1", "Build", running);
  const idle = session("s2", "Review", null);
  const projects = [project("p1", "Payments", [build]), project("p2", "Docs", [idle])];

  it("searches project names and session titles", () => {
    const all = paletteModel(projects, "", null, text);
    expect(all.mode).toBe("search");
    expect(all.entries.map((entry) => entry.kind)).toEqual([
      "project",
      "session",
      "project",
      "session",
    ]);

    const docs = paletteModel(projects, "  DOCS ", null, text);
    expect(docs.results.map((candidate) => candidate.id)).toEqual(["p2"]);

    const review = paletteModel(projects, "review", null, text);
    expect(review.results.map((candidate) => candidate.id)).toEqual(["p2"]);
    expect(review.entries).toHaveLength(2);

    expect(paletteModel(projects, "nothing", null, text).entries).toEqual([]);
  });

  it("reads a leading > as the raw line to type, keeping the user's spacing", () => {
    expect(dispatchText("> make test")).toBe("make test");
    expect(dispatchText(">make test")).toBe("make test");
    expect(dispatchText(">  two spaces")).toBe(" two spaces");
    expect(dispatchText("> trailing  ")).toBe("trailing  ");
    expect(dispatchText(">")).toBe("");
    expect(dispatchText("make > test")).toBeNull();
    expect(dispatchText("")).toBeNull();
  });

  it("offers one dispatch entry aimed at the active session, honest about whether it can take it", () => {
    const live = paletteModel(projects, "> git status", build, text);
    expect(live.mode).toBe("dispatch");
    expect(live.results).toEqual([]);
    expect(live.entries).toEqual([
      { kind: "dispatch", text: "git status", sessionTitle: "Build", enabled: true },
    ]);

    // A session that is not running cannot receive keystrokes; the entry says so instead of
    // pretending the line went somewhere.
    const notRunning = paletteModel(projects, "> ls", idle, text);
    expect(notRunning.entries).toEqual([
      { kind: "dispatch", text: "ls", sessionTitle: "Review", enabled: false },
    ]);
    const nothingActive = paletteModel(projects, "> ls", null, text);
    expect(nothingActive.entries).toEqual([
      { kind: "dispatch", text: "ls", sessionTitle: null, enabled: false },
    ]);
  });
});
