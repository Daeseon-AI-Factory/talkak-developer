import type { LaunchProfile, Project } from "./domain";

export const PROJECTS_STORAGE_KEY = "talkak.projects.v1";

export interface ProjectDraft {
  name: string;
  description: string;
  path: string;
  launchProfile: LaunchProfile;
}

export interface ProjectStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

interface StoredProject {
  id: string;
  name: string;
  monogram: string;
  color: string;
  path: string;
  branch: string;
  description: string;
  launchProfile: LaunchProfile;
}

interface StoredProjectsPayload {
  version: 1;
  projects: StoredProject[];
}

const PROJECT_COLORS = ["#5fe2ed", "#a78bfa", "#fb923c", "#73dfa8", "#f472b6"] as const;

export function parseLaunchArguments(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((argument) => argument.trim())
    .filter(Boolean);
}

export function normalizeLaunchProfile(profile: LaunchProfile): LaunchProfile {
  const command = profile.command?.trim() || null;
  return {
    label: profile.label.trim(),
    command,
    args: command ? profile.args.map((argument) => argument.trim()).filter(Boolean) : [],
  };
}

export function createLocalProject(draft: ProjectDraft, id = createProjectId()): Project {
  const name = draft.name.trim();
  return {
    id,
    source: "local",
    name,
    monogram: Array.from(name)[0]?.toLocaleUpperCase() ?? "?",
    color: colorForId(id),
    path: draft.path.trim(),
    branch: "—",
    description: draft.description.trim(),
    launchProfile: normalizeLaunchProfile(draft.launchProfile),
    sessions: [],
  };
}

export function updateLocalProject(project: Project, draft: ProjectDraft): Project {
  const updated = createLocalProject(draft, project.id);
  return {
    ...updated,
    color: project.color,
    sessions: project.sessions,
  };
}

export function readStoredProjects(storage: ProjectStorage): Project[] {
  try {
    const serialized = storage.getItem(PROJECTS_STORAGE_KEY);
    if (!serialized) return [];
    const payload: unknown = JSON.parse(serialized);
    if (!isRecord(payload) || payload.version !== 1 || !Array.isArray(payload.projects)) return [];

    const projects: Project[] = [];
    const ids = new Set<string>();
    for (const candidate of payload.projects) {
      const stored = readStoredProject(candidate);
      if (!stored || ids.has(stored.id)) continue;
      ids.add(stored.id);
      projects.push({ ...stored, source: "local", sessions: [] });
    }
    return projects;
  } catch {
    return [];
  }
}

export function writeStoredProjects(storage: ProjectStorage, projects: readonly Project[]): number {
  const localProjects: StoredProject[] = projects
    .filter((project) => project.source === "local")
    .map(({ source: _source, sessions: _sessions, ...project }) => ({
      ...project,
      launchProfile: normalizeLaunchProfile(project.launchProfile),
    }));
  const payload: StoredProjectsPayload = { version: 1, projects: localProjects };
  storage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(payload));
  return localProjects.length;
}

export function browserProjectStorage(): ProjectStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readStoredProject(value: unknown): StoredProject | null {
  if (!isRecord(value)) return null;
  const fields = [
    value.id,
    value.name,
    value.monogram,
    value.color,
    value.path,
    value.branch,
    value.description,
  ];
  if (!fields.every((field) => typeof field === "string")) return null;
  const launchProfile = readLaunchProfile(value.launchProfile);
  if (!launchProfile || !value.id || !value.name || !value.path) return null;
  return {
    id: value.id as string,
    name: value.name as string,
    monogram: value.monogram as string,
    color: value.color as string,
    path: value.path as string,
    branch: value.branch as string,
    description: value.description as string,
    launchProfile,
  };
}

function readLaunchProfile(value: unknown): LaunchProfile | null {
  if (
    !isRecord(value) ||
    typeof value.label !== "string" ||
    (value.command !== null && typeof value.command !== "string") ||
    !Array.isArray(value.args) ||
    !value.args.every((argument) => typeof argument === "string")
  ) {
    return null;
  }
  return normalizeLaunchProfile({
    label: value.label,
    command: value.command,
    args: value.args,
  });
}

function colorForId(id: string): string {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return PROJECT_COLORS[hash % PROJECT_COLORS.length];
}

function createProjectId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `project-${uuid}`;
  return `project-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
