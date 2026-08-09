import { describe, expect, it } from "vitest";
import type { Project } from "./domain";
import {
  PROJECTS_STORAGE_KEY,
  type ProjectDraft,
  type ProjectStorage,
  createLocalProject,
  parseLaunchArguments,
  readStoredProjects,
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

  it("does not persist preview projects and ignores malformed storage", () => {
    const storage = memoryStorage("not-json");
    expect(readStoredProjects(storage)).toEqual([]);

    const preview = { ...createLocalProject(draft(), "preview-1"), source: "preview" } as Project;
    expect(writeStoredProjects(storage, [preview])).toBe(0);
    expect(readStoredProjects(storage)).toEqual([]);
  });
});
