import type { DevSession, Project } from "./domain";
import type { LayoutNode, PaneNode, WorkspacePage } from "./layoutModel";
import { listPanes } from "./layoutModel";
import type { LocalizedText } from "./localizedText";
import { readPageTitle, readSessionTitle } from "./localizedText";
import type { ProjectStorage } from "./projectStore";

export const WORKSPACE_STORAGE_KEY = "talkak.workspace.v2";
export const LEGACY_WORKSPACE_STORAGE_KEY = "talkak.workspace.v1";

// Safety maximums for corrupted or hand-edited localStorage payloads.
const MAX_PROJECTS = 100;
const MAX_PAGES_PER_PROJECT = 100;
const MAX_SESSIONS_PER_PROJECT = 500;
const MAX_LAYOUT_DEPTH = 32;
const MAX_LAYOUT_NODES = 500;

export type ProjectPages = Record<string, WorkspacePage[]>;
export type ActivePages = Record<string, string>;
export type ActivePanes = Record<string, string>;

export interface StoredSessionMetadata {
  id: string;
  title: LocalizedText;
  createdAt: string;
}

export interface StoredProjectWorkspace {
  projectId: string;
  sessions: StoredSessionMetadata[];
  pages: WorkspacePage[];
  activePageId: string;
  activePaneByPage: ActivePanes;
}

export interface WorkspaceSnapshot {
  version: 2;
  activeProjectId: string | null;
  projects: StoredProjectWorkspace[];
}

export interface WorkspaceStateForStorage {
  activeProjectId: string;
  pagesByProject: ProjectPages;
  activePageByProject: ActivePages;
  activePaneByPage: ActivePanes;
}

export type RestoreSession = (
  project: Project,
  metadata: StoredSessionMetadata,
  index: number,
) => DevSession;

export function readWorkspaceSnapshot(storage: ProjectStorage | null): WorkspaceSnapshot | null {
  if (!storage) return null;
  for (const [key, version] of [
    [WORKSPACE_STORAGE_KEY, 2],
    [LEGACY_WORKSPACE_STORAGE_KEY, 1],
  ] as const) {
    try {
      const serialized = storage.getItem(key);
      if (!serialized) continue;
      const snapshot = parseWorkspaceSnapshot(JSON.parse(serialized), version);
      if (snapshot) return snapshot;
    } catch {
      // Try the legacy snapshot when the new payload is absent or malformed.
    }
  }
  return null;
}

export function workspaceForProject(
  snapshot: WorkspaceSnapshot | null,
  projectId: string,
): StoredProjectWorkspace | null {
  return snapshot?.projects.find((workspace) => workspace.projectId === projectId) ?? null;
}

export function hydrateWorkspaceProjects(
  projects: readonly Project[],
  snapshot: WorkspaceSnapshot | null,
  restoreSession: RestoreSession,
): Project[] {
  return projects.map((project) => {
    if (project.source !== "local") return project;
    const workspace = workspaceForProject(snapshot, project.id);
    if (!workspace) return project;
    return {
      ...project,
      sessions: workspace.sessions.map((metadata, index) =>
        restoreSession(project, metadata, index),
      ),
    };
  });
}

export function writeWorkspaceSnapshot(
  storage: ProjectStorage,
  projects: readonly Project[],
  state: WorkspaceStateForStorage,
): number {
  const localProjects = projects.filter((project) => project.source === "local");
  const payload: WorkspaceSnapshot = {
    version: 2,
    activeProjectId: localProjects.some((project) => project.id === state.activeProjectId)
      ? state.activeProjectId
      : null,
    projects: localProjects.map((project) => {
      const pages = (state.pagesByProject[project.id] ?? []).map(serializePage);
      const pageIds = new Set(pages.map((page) => page.id));
      const activePaneByPage = Object.fromEntries(
        pages.flatMap((page) => {
          const paneId = state.activePaneByPage[page.id];
          return paneId && listPanes(page.root).some((pane) => pane.id === paneId)
            ? [[page.id, paneId]]
            : [];
        }),
      );
      const requestedActivePage = state.activePageByProject[project.id];
      return {
        projectId: project.id,
        sessions: project.sessions.map((session) => ({
          id: session.id,
          title: session.title,
          createdAt: session.startedAt,
        })),
        pages,
        activePageId: pageIds.has(requestedActivePage) ? requestedActivePage : (pages[0]?.id ?? ""),
        activePaneByPage,
      };
    }),
  };
  storage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(payload));
  return localProjects.length;
}

function parseWorkspaceSnapshot(value: unknown, expectedVersion: 1 | 2): WorkspaceSnapshot | null {
  if (!isRecord(value) || value.version !== expectedVersion || !Array.isArray(value.projects)) {
    return null;
  }

  const projectIds = new Set<string>();
  const sessionIds = new Set<string>();
  const pageIds = new Set<string>();
  const nodeIds = new Set<string>();
  const projects: StoredProjectWorkspace[] = [];

  for (const candidate of value.projects.slice(0, MAX_PROJECTS)) {
    const project = readProjectWorkspace(candidate, { projectIds, sessionIds, pageIds, nodeIds });
    if (project) projects.push(project);
  }
  const activeProjectId =
    typeof value.activeProjectId === "string" &&
    projects.some((project) => project.projectId === value.activeProjectId)
      ? value.activeProjectId
      : null;
  return { version: 2, activeProjectId, projects };
}

function readProjectWorkspace(
  value: unknown,
  ids: {
    projectIds: Set<string>;
    sessionIds: Set<string>;
    pageIds: Set<string>;
    nodeIds: Set<string>;
  },
): StoredProjectWorkspace | null {
  if (
    !isRecord(value) ||
    typeof value.projectId !== "string" ||
    ids.projectIds.has(value.projectId)
  ) {
    return null;
  }
  if (!Array.isArray(value.sessions) || !Array.isArray(value.pages)) return null;

  const sessions: StoredSessionMetadata[] = [];
  const projectSessionIds = new Set<string>();
  for (const candidate of value.sessions.slice(0, MAX_SESSIONS_PER_PROJECT)) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== "string" ||
      typeof candidate.createdAt !== "string" ||
      !candidate.id ||
      ids.sessionIds.has(candidate.id)
    ) {
      continue;
    }
    const title = readSessionTitle(candidate.title);
    if (title === null) continue;
    ids.sessionIds.add(candidate.id);
    projectSessionIds.add(candidate.id);
    sessions.push({ id: candidate.id, title, createdAt: candidate.createdAt });
  }

  const pages: WorkspacePage[] = [];
  for (const candidate of value.pages.slice(0, MAX_PAGES_PER_PROJECT)) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== "string" ||
      !candidate.id ||
      ids.pageIds.has(candidate.id)
    ) {
      continue;
    }
    const title = readPageTitle(candidate.title);
    if (title === null) continue;
    const budget = { count: 0 };
    const root = readLayoutNode(candidate.root, projectSessionIds, ids.nodeIds, budget, 0);
    ids.pageIds.add(candidate.id);
    pages.push({ id: candidate.id, title, root });
  }

  const pageIdSet = new Set(pages.map((page) => page.id));
  const requestedActivePage =
    typeof value.activePageId === "string" && pageIdSet.has(value.activePageId)
      ? value.activePageId
      : (pages[0]?.id ?? "");
  const activePaneByPage: ActivePanes = {};
  if (isRecord(value.activePaneByPage)) {
    for (const page of pages) {
      const paneId = value.activePaneByPage[page.id];
      if (typeof paneId === "string" && listPanes(page.root).some((pane) => pane.id === paneId)) {
        activePaneByPage[page.id] = paneId;
      }
    }
  }

  ids.projectIds.add(value.projectId);
  return {
    projectId: value.projectId,
    sessions,
    pages,
    activePageId: requestedActivePage,
    activePaneByPage,
  };
}

function readLayoutNode(
  value: unknown,
  validSessionIds: ReadonlySet<string>,
  nodeIds: Set<string>,
  budget: { count: number },
  depth: number,
): LayoutNode | null {
  if (value === null) return null;
  if (depth > MAX_LAYOUT_DEPTH || budget.count >= MAX_LAYOUT_NODES || !isRecord(value)) return null;
  budget.count += 1;

  if (value.kind === "pane") {
    if (
      typeof value.id !== "string" ||
      typeof value.sessionId !== "string" ||
      nodeIds.has(value.id) ||
      !validSessionIds.has(value.sessionId)
    ) {
      return null;
    }
    nodeIds.add(value.id);
    return { kind: "pane", id: value.id, sessionId: value.sessionId } satisfies PaneNode;
  }

  if (
    value.kind !== "split" ||
    typeof value.id !== "string" ||
    nodeIds.has(value.id) ||
    (value.direction !== "horizontal" && value.direction !== "vertical") ||
    typeof value.ratio !== "number" ||
    !Number.isFinite(value.ratio) ||
    value.ratio <= 0 ||
    value.ratio >= 1
  ) {
    return null;
  }

  nodeIds.add(value.id);
  const first = readLayoutNode(value.first, validSessionIds, nodeIds, budget, depth + 1);
  const second = readLayoutNode(value.second, validSessionIds, nodeIds, budget, depth + 1);
  if (!first) return second;
  if (!second) return first;
  return {
    kind: "split",
    id: value.id,
    direction: value.direction,
    ratio: value.ratio,
    first,
    second,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function serializePage(page: WorkspacePage): WorkspacePage {
  return {
    id: page.id,
    title: page.title,
    root: serializeLayoutNode(page.root),
  };
}

function serializeLayoutNode(node: LayoutNode): LayoutNode;
function serializeLayoutNode(node: null): null;
function serializeLayoutNode(node: LayoutNode | null): LayoutNode | null;
function serializeLayoutNode(node: LayoutNode | null): LayoutNode | null {
  if (node === null) return null;
  if (node.kind === "pane") {
    return { kind: "pane", id: node.id, sessionId: node.sessionId };
  }
  return {
    kind: "split",
    id: node.id,
    direction: node.direction,
    ratio: node.ratio,
    first: serializeLayoutNode(node.first),
    second: serializeLayoutNode(node.second),
  };
}
