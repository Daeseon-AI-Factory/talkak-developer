import { describe, expect, it } from "vitest";
import { projects } from "./demo";
import { createLocalProject } from "./projectStore";
import { createInitialWorkspace, initialFocusedSessionId } from "./workspaceBootstrap";
import type { WorkspaceSnapshot } from "./workspaceStore";

describe("createInitialWorkspace", () => {
  it("creates an actionable empty page for a project without sessions", () => {
    const project = createLocalProject(
      {
        name: "Local",
        description: "",
        path: "/workspace/local",
        launchProfile: { label: "Shell", command: null, args: [] },
      },
      "project-local",
    );

    const state = createInitialWorkspace([project], null);

    expect(state.pages[project.id]).toEqual([
      {
        id: "page-project-local-1",
        title: "Page 1",
        root: null,
      },
    ]);
    expect(state.active[project.id]).toBe("page-project-local-1");
    expect(initialFocusedSessionId(state, project.id)).toBeNull();
  });

  it("repairs a stored local workspace that has no pages", () => {
    const project = createLocalProject(
      {
        name: "Local",
        description: "",
        path: "/workspace/local",
        launchProfile: { label: "Shell", command: null, args: [] },
      },
      "project-local",
    );
    const snapshot: WorkspaceSnapshot = {
      version: 1,
      projects: [
        {
          projectId: project.id,
          sessions: [],
          pages: [],
          activePageId: "",
          activePaneByPage: {},
        },
      ],
    };

    const state = createInitialWorkspace([project], snapshot);

    expect(state.pages[project.id]).toEqual([
      {
        id: "page-project-local-1",
        title: "Page 1",
        root: null,
      },
    ]);
    expect(state.active[project.id]).toBe("page-project-local-1");
  });

  it("names a preview workspace page independently from its session", () => {
    const [project] = projects;
    const state = createInitialWorkspace([project], null);

    expect(state.pages[project.id][0]?.title).toBe("Page 1");
    expect(state.pages[project.id][0]?.title).not.toBe(project.sessions[0]?.title);
  });

  it("restores the focused session from the stored active page", () => {
    const project = createLocalProject(
      {
        name: "Local",
        description: "",
        path: "/workspace/local",
        launchProfile: { label: "Shell", command: null, args: [] },
      },
      "project-local",
    );
    const snapshot: WorkspaceSnapshot = {
      version: 1,
      projects: [
        {
          projectId: project.id,
          sessions: [
            { id: "session-1", title: "One", createdAt: "one" },
            { id: "session-2", title: "Two", createdAt: "two" },
          ],
          pages: [
            {
              id: "page-1",
              title: "Page 1",
              root: { kind: "pane", id: "pane-1", sessionId: "session-1" },
            },
            {
              id: "page-2",
              title: "Page 2",
              root: { kind: "pane", id: "pane-2", sessionId: "session-2" },
            },
          ],
          activePageId: "page-2",
          activePaneByPage: { "page-1": "pane-1", "page-2": "pane-2" },
        },
      ],
    };

    const state = createInitialWorkspace([project], snapshot);

    expect(state.active[project.id]).toBe("page-2");
    expect(initialFocusedSessionId(state, project.id)).toBe("session-2");
  });
});
