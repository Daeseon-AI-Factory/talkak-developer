import { describe, expect, it } from "vitest";
import type { Project } from "./domain";
import {
  PROJECTS_STORAGE_KEY,
  type ProjectDraft,
  type ProjectStorage,
  createLocalProject,
  moveProject,
  parseLaunchArguments,
  readStoredProjects,
  removeLocalProject,
  writeStoredProjects,
} from "./projectStore";

function draft(): ProjectDraft {
  return {
    name: "  My App  ",
    description: "  Local workspace  ",
    path: "  C:\\work\\my-app  ",
    launchProfile: {
      label: "  Review profile  ",
      command: "  agent-cli  ",
      args: ["  --mode  ", "  review  "],
    },
  };
}

function memoryStorage(initial?: string): ProjectStorage & { value: string | null } {
  return {
    value: initial ?? null,
    getItem(key) {
      return key === PROJECTS_STORAGE_KEY ? this.value : null;
    },
    setItem(key, value) {
      if (key === PROJECTS_STORAGE_KEY) this.value = value;
    },
  };
}

describe("project store", () => {
  it("keeps one exact launch argument per non-empty line", () => {
    expect(parseLaunchArguments(" --mode\r\nreview target\n\n --safe ")).toEqual([
      "--mode",
      "review target",
      "--safe",
    ]);
  });

  it("normalizes a local project and restores only durable configuration", () => {
    const storage = memoryStorage();
    const project = createLocalProject(draft(), "project-1");
    project.sessions.push({ id: "runtime-only" } as Project["sessions"][number]);

    expect(writeStoredProjects(storage, [project])).toBe(1);
    expect(readStoredProjects(storage)).toEqual([
      {
        id: "project-1",
        source: "local",
        name: "My App",
        monogram: "M",
        color: project.color,
        path: "C:\\work\\my-app",
        branch: "—",
        description: "Local workspace",
        launchProfile: {
          label: "Review profile",
          command: "agent-cli",
          args: ["--mode", "review"],
        },
        sessions: [],
      },
    ]);
  });

  it("removes only local projects and leaves the rest in order", () => {
    const first = createLocalProject(draft(), "project-1");
    const second = createLocalProject(draft(), "project-2");
    const preview = { ...createLocalProject(draft(), "preview-1"), source: "preview" } as Project;
    const projects = [first, preview, second];

    expect(removeLocalProject(projects, "project-1").map((project) => project.id)).toEqual([
      "preview-1",
      "project-2",
    ]);
    // An example project is not a thing to delete; neither is an id that names nothing.
    expect(removeLocalProject(projects, "preview-1")).toEqual(projects);
    expect(removeLocalProject(projects, "missing")).toEqual(projects);
    expect(removeLocalProject(projects, "missing")).not.toBe(projects);
  });

  it("moves a project to a new position without disturbing the others", () => {
    const projects = ["a", "b", "c", "d"].map((id) => createLocalProject(draft(), id));
    const ids = (list: readonly Project[]) => list.map((project) => project.id);

    expect(ids(moveProject(projects, 0, 2))).toEqual(["b", "c", "a", "d"]);
    expect(ids(moveProject(projects, 3, 0))).toEqual(["d", "a", "b", "c"]);
    expect(ids(moveProject(projects, 1, 2))).toEqual(["a", "c", "b", "d"]);
    // Moving up from the top, down from the bottom, or onto itself changes nothing.
    expect(ids(moveProject(projects, 0, -1))).toEqual(["a", "b", "c", "d"]);
    expect(ids(moveProject(projects, 3, 4))).toEqual(["a", "b", "c", "d"]);
    expect(ids(moveProject(projects, 2, 2))).toEqual(["a", "b", "c", "d"]);
    expect(moveProject(projects, 0, 1)).not.toBe(projects);
    // The stored order is the new order.
    const storage = memoryStorage();
    writeStoredProjects(storage, moveProject(projects, 3, 0));
    expect(ids(readStoredProjects(storage))).toEqual(["d", "a", "b", "c"]);
  });

  it("writes an empty payload when the last local project goes, so it stays gone", () => {
    const storage = memoryStorage();
    const only = createLocalProject(draft(), "project-1");
    writeStoredProjects(storage, [only]);
    expect(readStoredProjects(storage)).toHaveLength(1);
    expect(writeStoredProjects(storage, removeLocalProject([only], "project-1"))).toBe(0);
    expect(readStoredProjects(storage)).toEqual([]);
  });

  it("does not persist preview projects and ignores malformed storage", () => {
    const storage = memoryStorage("not-json");
    expect(readStoredProjects(storage)).toEqual([]);

    const preview = { ...createLocalProject(draft(), "preview-1"), source: "preview" } as Project;
    expect(writeStoredProjects(storage, [preview])).toBe(0);
    expect(readStoredProjects(storage)).toEqual([]);
  });
});
