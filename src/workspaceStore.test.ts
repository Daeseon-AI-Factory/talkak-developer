import { describe, expect, it } from "vitest";
import type { Project } from "./domain";
import { createWorkspaceSession } from "./sessionModel";
import {
  LEGACY_WORKSPACE_STORAGE_KEY,
  WORKSPACE_STORAGE_KEY,
  hydrateWorkspaceProjects,
  readWorkspaceSnapshot,
  writeWorkspaceSnapshot,
} from "./workspaceStore";

function localProject(): Project {
  return {
    id: "project-1",
    source: "local",
    name: "Project",
    monogram: "P",
    color: "#fff",
    path: "/project",
    branch: "main",
    description: "",
    launchProfile: { label: "Agent", command: "agent", args: ["SECRET_ARGUMENT"] },
    sessions: [
      createWorkspaceSession({
        id: "session-1",
        title: "Session 1",
        profile: "Agent",
        launchProfile: { label: "Agent", command: "agent", args: ["SECRET_ARGUMENT"] },
        createdAt: "2026-08-09T00:00:00.000Z",
        lastActivity: "now",
        intro: "SECRET_OUTPUT",
        outcome: "SECRET_SUMMARY",
        nextStep: "next",
        launchRequested: true,
      }),
    ],
  };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    values,
  };
}

describe("workspace storage", () => {
  it("round-trips page layout and excludes runtime content and launch configuration", () => {
    const storage = memoryStorage();
    const project = localProject();
    const pageWithExtras = {
      id: "page-1",
      title: "Page 1",
      diagnostic: "SECRET_PAGE_DIAGNOSTIC",
      root: {
        kind: "pane" as const,
        id: "pane-1",
        sessionId: "session-1",
        bufferedOutput: "SECRET_PANE_OUTPUT",
      },
    };
    writeWorkspaceSnapshot(storage, [project], {
      activeProjectId: "project-1",
      pagesByProject: { "project-1": [pageWithExtras] },
      activePageByProject: { "project-1": "page-1" },
      activePaneByPage: { "page-1": "pane-1" },
    });

    const serialized = storage.values.get(WORKSPACE_STORAGE_KEY) ?? "";
    expect(serialized).not.toContain("SECRET_ARGUMENT");
    expect(serialized).not.toContain("SECRET_OUTPUT");
    expect(serialized).not.toContain("SECRET_SUMMARY");
    expect(serialized).not.toContain("SECRET_PAGE_DIAGNOSTIC");
    expect(serialized).not.toContain("SECRET_PANE_OUTPUT");

    const snapshot = readWorkspaceSnapshot(storage);
    expect(snapshot?.projects[0]?.pages[0]?.root).toEqual({
      kind: "pane",
      id: "pane-1",
      sessionId: "session-1",
    });
    expect(snapshot?.projects[0]?.activePaneByPage).toEqual({ "page-1": "pane-1" });
    expect(snapshot?.activeProjectId).toBe("project-1");
  });

  it("persists only a valid local active project", () => {
    const storage = memoryStorage();
    const first = localProject();
    const second: Project = {
      ...localProject(),
      id: "project-2",
      sessions: [],
    };

    writeWorkspaceSnapshot(storage, [first, second], {
      activeProjectId: second.id,
      pagesByProject: { "project-1": [], "project-2": [] },
      activePageByProject: {},
      activePaneByPage: {},
    });

    expect(readWorkspaceSnapshot(storage)?.activeProjectId).toBe("project-2");
  });

  it("round-trips semantic generated titles without converting user-authored titles", () => {
    const storage = memoryStorage();
    const project = localProject();
    project.sessions[0].title = { kind: "session-title", index: 1 };

    writeWorkspaceSnapshot(storage, [project], {
      activeProjectId: project.id,
      pagesByProject: {
        [project.id]: [
          {
            id: "page-generated",
            title: { kind: "page-title", index: 1 },
            root: { kind: "pane", id: "pane-generated", sessionId: "session-1" },
          },
          { id: "page-user", title: "API review", root: null },
        ],
      },
      activePageByProject: { [project.id]: "page-generated" },
      activePaneByPage: { "page-generated": "pane-generated" },
    });

    const snapshot = readWorkspaceSnapshot(storage);
    expect(snapshot?.projects[0]?.sessions[0]?.title).toEqual({
      kind: "session-title",
      index: 1,
    });
    expect(snapshot?.projects[0]?.pages.map((page) => page.title)).toEqual([
      { kind: "page-title", index: 1 },
      "API review",
    ]);
  });

  it("drops dangling panes and never restores an automatic launch intent", () => {
    const storage = memoryStorage();
    storage.setItem(
      WORKSPACE_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        projects: [
          {
            projectId: "project-1",
            sessions: [{ id: "session-1", title: "Restored", createdAt: "then" }],
            pages: [
              {
                id: "page-1",
                title: "Page 1",
                root: {
                  kind: "split",
                  id: "split-1",
                  direction: "horizontal",
                  ratio: 0.5,
                  first: { kind: "pane", id: "pane-1", sessionId: "session-1" },
                  second: { kind: "pane", id: "pane-bad", sessionId: "missing" },
                },
              },
            ],
            activePageId: "page-1",
            activePaneByPage: { "page-1": "pane-1" },
          },
        ],
      }),
    );

    const snapshot = readWorkspaceSnapshot(storage);
    expect(snapshot?.activeProjectId).toBeNull();
    expect(snapshot?.projects[0]?.pages[0]?.root).toEqual({
      kind: "pane",
      id: "pane-1",
      sessionId: "session-1",
    });
    const hydrated = hydrateWorkspaceProjects([localProject()], snapshot, (project, item) =>
      createWorkspaceSession({
        id: item.id,
        title: item.title,
        profile: project.launchProfile.label,
        launchProfile: project.launchProfile,
        createdAt: item.createdAt,
        lastActivity: "restored",
        intro: "",
        outcome: "",
        nextStep: "",
        launchRequested: false,
      }),
    );
    expect(hydrated[0].sessions[0]?.launchRequested).toBe(false);
  });

  it("reads a legacy v1 snapshot without overwriting or deleting it", () => {
    const storage = memoryStorage();
    const legacy = JSON.stringify({
      version: 1,
      projects: [
        {
          projectId: "project-1",
          sessions: [{ id: "session-1", title: "Session 1", createdAt: "then" }],
          pages: [
            {
              id: "page-1",
              title: "Page 1",
              root: { kind: "pane", id: "pane-1", sessionId: "session-1" },
            },
          ],
          activePageId: "page-1",
          activePaneByPage: { "page-1": "pane-1" },
        },
      ],
    });
    storage.setItem(LEGACY_WORKSPACE_STORAGE_KEY, legacy);

    const snapshot = readWorkspaceSnapshot(storage);

    expect(snapshot?.version).toBe(2);
    expect(snapshot?.projects[0]?.sessions[0]?.title).toBe("Session 1");
    expect(snapshot?.projects[0]?.pages[0]?.title).toBe("Page 1");
    expect(storage.values.get(LEGACY_WORKSPACE_STORAGE_KEY)).toBe(legacy);
    expect(storage.values.has(WORKSPACE_STORAGE_KEY)).toBe(false);
  });

  it("falls back to v1 when the v2 payload is malformed", () => {
    const storage = memoryStorage();
    storage.setItem(WORKSPACE_STORAGE_KEY, "not-json");
    storage.setItem(
      LEGACY_WORKSPACE_STORAGE_KEY,
      JSON.stringify({ version: 1, projects: [], activeProjectId: null }),
    );

    expect(readWorkspaceSnapshot(storage)).toEqual({
      version: 2,
      activeProjectId: null,
      projects: [],
    });
  });
});
