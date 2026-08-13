import type { Project } from "./domain";
import { type WorkspacePage, createPage } from "./layoutModel";
import { focusedPane } from "./workspaceFocus";
import type { ActivePages, ActivePanes, ProjectPages, WorkspaceSnapshot } from "./workspaceStore";
import { workspaceForProject } from "./workspaceStore";

export interface InitialWorkspaceState {
  pages: ProjectPages;
  active: ActivePages;
  focused: ActivePanes;
}

export function createInitialWorkspace(
  projects: readonly Project[],
  snapshot: WorkspaceSnapshot | null,
  pageTitle: (index: number) => string = (index) => `Page ${index}`,
): InitialWorkspaceState {
  const pages: ProjectPages = {};
  const active: ActivePages = {};
  const focused: ActivePanes = {};

  for (const project of projects) {
    const stored = project.source === "local" ? workspaceForProject(snapshot, project.id) : null;
    if (stored) {
      const storedPages =
        stored.pages.length > 0 ? stored.pages : [createEmptyPage(project.id, pageTitle(1))];
      pages[project.id] = storedPages;
      active[project.id] = storedPages.some((page) => page.id === stored.activePageId)
        ? stored.activePageId
        : storedPages[0].id;
      Object.assign(focused, stored.activePaneByPage);
      continue;
    }

    const firstSession = project.sessions[0];
    if (!firstSession) {
      const page = createEmptyPage(project.id, pageTitle(1));
      pages[project.id] = [page];
      active[project.id] = page.id;
      continue;
    }

    const page = createPage({
      pageId: `page-${project.id}-1`,
      title: pageTitle(1),
      paneId: `pane-${firstSession.id}`,
      sessionId: firstSession.id,
    });
    pages[project.id] = [page];
    active[project.id] = page.id;
    focused[page.id] = page.root?.id ?? "";
  }

  return { pages, active, focused };
}

function createEmptyPage(projectId: string, title: string): WorkspacePage {
  return {
    id: `page-${projectId}-1`,
    title,
    root: null,
  };
}

export function initialFocusedSessionId(
  state: InitialWorkspaceState,
  projectId: string,
): string | null {
  const pages = state.pages[projectId] ?? [];
  const activePage = pages.find((page) => page.id === state.active[projectId]) ?? pages[0];
  return (
    focusedPane(activePage, activePage ? state.focused[activePage.id] : null)?.sessionId ?? null
  );
}
