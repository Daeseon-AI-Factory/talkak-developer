import { type Dispatch, type SetStateAction, useEffect, useMemo, useRef, useState } from "react";
import type { PresentationMode } from "./adaptiveLayout";
import type { DevSession, Project, TerminalRuntimeObservation } from "./domain";
import {
  type LayoutNode,
  type SplitDirection,
  type WorkspacePage,
  createPage,
  listPanes,
  removePane,
  splitPane,
  updateSplitRatio,
} from "./layoutModel";
import { browserProjectStorage } from "./projectStore";
import { createWorkspaceSession } from "./sessionModel";
import { applyRuntimeObservationToProjects } from "./sessionRuntimeState";
import {
  createInitialWorkspace,
  initialFocusedSessionId,
  initialProjectId,
} from "./workspaceBootstrap";
import { cycleFocusedPane, focusedPane } from "./workspaceFocus";
import { nextGeneratedPageTitle } from "./workspaceModel";
import {
  type ActivePages,
  type ActivePanes,
  type ProjectPages,
  type WorkspaceSnapshot,
  writeWorkspaceSnapshot,
} from "./workspaceStore";

interface WorkspaceControllerInput {
  projects: Project[];
  setProjects: Dispatch<SetStateAction<Project[]>>;
  presentationMode: PresentationMode;
  snapshot: WorkspaceSnapshot | null;
}

export function useWorkspaceController({
  projects,
  setProjects,
  presentationMode,
  snapshot,
}: WorkspaceControllerInput) {
  const [initial] = useState(() => createInitialWorkspace(projects, snapshot));
  const [pagesByProject, setPagesByProject] = useState<ProjectPages>(initial.pages);
  const [activePageByProject, setActivePageByProject] = useState<ActivePages>(initial.active);
  const [activePaneByPage, setActivePaneByPage] = useState<ActivePanes>(initial.focused);
  const [initialSelection] = useState(() => {
    const projectId = initialProjectId(projects, snapshot);
    return {
      projectId,
      sessionId: projectId ? initialFocusedSessionId(initial, projectId) : null,
    };
  });
  const [activeProjectId, setActiveProjectId] = useState(initialSelection.projectId);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(initialSelection.sessionId);
  const fallbackCounter = useRef(0);

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? projects[0],
    [activeProjectId, projects],
  );
  if (!activeProject) throw new Error("Talkak requires at least one project.");
  const activePages = pagesByProject[activeProject.id] ?? [];
  const activePageId = activePageByProject[activeProject.id] ?? activePages[0]?.id ?? "";
  const activePage = activePages.find((page) => page.id === activePageId) ?? activePages[0];
  const activePane = focusedPane(activePage, activePage ? activePaneByPage[activePage.id] : null);
  const activeSession =
    activeProject.sessions.find((session) => session.id === activeSessionId) ??
    activeProject.sessions.find((session) => session.id === activePane?.sessionId) ??
    null;

  useEffect(() => {
    if (activeProject.id === activeProjectId) return;
    setActiveProjectId(activeProject.id);
  }, [activeProject, activeProjectId]);

  useEffect(() => {
    if (!projects.some((project) => project.source === "local")) return;
    const storage = browserProjectStorage();
    if (!storage) return;
    try {
      writeWorkspaceSnapshot(storage, projects, {
        activeProjectId,
        pagesByProject,
        activePageByProject,
        activePaneByPage,
      });
    } catch {
      // The current workspace remains usable when browser storage is unavailable.
    }
  }, [activePageByProject, activePaneByPage, activeProjectId, pagesByProject, projects]);

  useEffect(() => {
    if (presentationMode === "phone" || !activeSessionId) return;
    const session = activeProject.sessions.find((candidate) => candidate.id === activeSessionId);
    if (!session) return;
    const existingPage = activePages.find((page) =>
      listPanes(page.root).some((pane) => pane.sessionId === activeSessionId),
    );
    if (existingPage) {
      const pane = listPanes(existingPage.root).find(
        (candidate) => candidate.sessionId === activeSessionId,
      );
      focusPage(activeProject.id, existingPage, pane?.id ?? null);
      return;
    }
    const page = createPage({
      pageId: nextId(`page-${activeProject.id}`, fallbackCounter),
      title: nextPageTitle(activePages),
      paneId: nextId("pane", fallbackCounter),
      sessionId: session.id,
    });
    setPagesByProject((current) => ({
      ...current,
      [activeProject.id]: [...(current[activeProject.id] ?? []), page],
    }));
    focusPage(activeProject.id, page, page.root?.id ?? null);
  }, [activeProject, activePages, activeSessionId, presentationMode]);

  function updatePage(
    projectId: string,
    pageId: string,
    update: (page: WorkspacePage) => WorkspacePage,
  ) {
    setPagesByProject((current) => ({
      ...current,
      [projectId]: (current[projectId] ?? []).map((page) =>
        page.id === pageId ? update(page) : page,
      ),
    }));
  }

  function focusPage(projectId: string, page: WorkspacePage, paneId: string | null) {
    const pane = focusedPane(page, paneId);
    setActivePageByProject((current) => ({ ...current, [projectId]: page.id }));
    if (pane) {
      setActivePaneByPage((current) => ({ ...current, [page.id]: pane.id }));
      setActiveSessionId(pane.sessionId);
    } else {
      setActiveSessionId(null);
    }
  }

  function focusWorkspacePane(paneId: string, sessionId: string) {
    if (!activePage) return;
    setActivePaneByPage((current) => ({ ...current, [activePage.id]: paneId }));
    setActiveSessionId(sessionId);
  }

  function selectProject(projectId: string) {
    const project = projects.find((candidate) => candidate.id === projectId);
    if (!project) return;
    const pages = pagesByProject[projectId] ?? [];
    const pageId = activePageByProject[projectId] ?? pages[0]?.id;
    const page = pages.find((candidate) => candidate.id === pageId) ?? pages[0];
    setActiveProjectId(projectId);
    if (page) focusPage(projectId, page, activePaneByPage[page.id] ?? null);
    else setActiveSessionId(null);
  }

  function selectPage(pageId: string) {
    if (!activeProject) return;
    const page = activePages.find((candidate) => candidate.id === pageId);
    if (page) focusPage(activeProject.id, page, activePaneByPage[page.id] ?? null);
  }

  function createWorkspacePage() {
    if (!activeProject) return;
    const session = makeSession(
      activeProject,
      activeProject.sessions.length + 1,
      true,
      fallbackCounter,
    );
    const page = createPage({
      pageId: nextId(`page-${activeProject.id}`, fallbackCounter),
      title: nextPageTitle(activePages),
      paneId: nextId("pane", fallbackCounter),
      sessionId: session.id,
    });
    setProjects((current) =>
      current.map((project) =>
        project.id === activeProject.id
          ? { ...project, sessions: [...project.sessions, session] }
          : project,
      ),
    );
    setPagesByProject((current) => ({
      ...current,
      [activeProject.id]: [...(current[activeProject.id] ?? []), page],
    }));
    focusPage(activeProject.id, page, page.root?.id ?? null);
  }

  function closeWorkspacePage(pageId: string) {
    if (!activeProject || activePages.length <= 1) return;
    const removedIndex = activePages.findIndex((page) => page.id === pageId);
    if (removedIndex < 0) return;
    const nextPages = activePages.filter((page) => page.id !== pageId);
    setPagesByProject((current) => ({ ...current, [activeProject.id]: nextPages }));
    setActivePaneByPage((current) => omitKey(current, pageId));
    if (pageId !== activePageId) return;
    const nextPage = nextPages[Math.min(removedIndex, nextPages.length - 1)];
    focusPage(activeProject.id, nextPage, activePaneByPage[nextPage.id] ?? null);
  }

  function attachSession(sessionId: string) {
    if (!activeProject || !activePage) return;
    const existingPage = activePages.find((page) =>
      listPanes(page.root).some((pane) => pane.sessionId === sessionId),
    );
    if (existingPage) {
      const pane = listPanes(existingPage.root).find(
        (candidate) => candidate.sessionId === sessionId,
      );
      focusPage(activeProject.id, existingPage, pane?.id ?? null);
      return;
    }
    const paneId = nextId("pane", fallbackCounter);
    updatePage(activeProject.id, activePage.id, (page) => ({
      ...page,
      root: { kind: "pane", id: paneId, sessionId },
    }));
    setActivePaneByPage((current) => ({ ...current, [activePage.id]: paneId }));
    setActiveSessionId(sessionId);
  }

  function createSessionInActivePage() {
    if (activePage && activePage.root !== null) return;
    const session = makeSession(
      activeProject,
      activeProject.sessions.length + 1,
      true,
      fallbackCounter,
    );
    const paneId = nextId("pane", fallbackCounter);
    const page =
      activePage ??
      ({
        id: nextId(`page-${activeProject.id}`, fallbackCounter),
        title: nextPageTitle(activePages),
        root: null,
      } satisfies WorkspacePage);
    const pageWithSession: WorkspacePage = {
      ...page,
      root: { kind: "pane", id: paneId, sessionId: session.id },
    };
    setProjects((current) =>
      current.map((project) =>
        project.id === activeProject.id
          ? { ...project, sessions: [...project.sessions, session] }
          : project,
      ),
    );
    if (activePage) {
      updatePage(activeProject.id, activePage.id, () => pageWithSession);
    } else {
      setPagesByProject((current) => ({
        ...current,
        [activeProject.id]: [...(current[activeProject.id] ?? []), pageWithSession],
      }));
    }
    setActivePageByProject((current) => ({ ...current, [activeProject.id]: page.id }));
    setActivePaneByPage((current) => ({ ...current, [page.id]: paneId }));
    setActiveSessionId(session.id);
  }

  function splitActivePane(paneId: string, direction: SplitDirection) {
    if (!activeProject || !activePage) return;
    if (!listPanes(activePage.root).some((pane) => pane.id === paneId)) return;
    if (presentationMode === "tablet" && listPanes(activePage.root).length >= 2) return;
    const session = makeSession(
      activeProject,
      activeProject.sessions.length + 1,
      true,
      fallbackCounter,
    );
    const nextPaneId = nextId("pane", fallbackCounter);
    setProjects((current) =>
      current.map((project) =>
        project.id === activeProject.id
          ? { ...project, sessions: [...project.sessions, session] }
          : project,
      ),
    );
    updatePage(activeProject.id, activePage.id, (page) => ({
      ...page,
      root: splitPane(page.root, paneId, {
        splitId: nextId("split", fallbackCounter),
        paneId: nextPaneId,
        sessionId: session.id,
        direction,
      }),
    }));
    setActivePaneByPage((current) => ({ ...current, [activePage.id]: nextPaneId }));
    setActiveSessionId(session.id);
  }

  function detachPane(paneId: string) {
    if (!activeProject || !activePage) return;
    const nextRoot = removePane(activePage.root, paneId);
    const nextPage = { ...activePage, root: nextRoot };
    updatePage(activeProject.id, activePage.id, () => nextPage);
    const nextPane = focusedPane(nextPage, activePaneByPage[activePage.id]);
    if (nextPane) {
      setActivePaneByPage((current) => ({ ...current, [activePage.id]: nextPane.id }));
      setActiveSessionId(nextPane.sessionId);
    } else {
      setActivePaneByPage((current) => omitKey(current, activePage.id));
      setActiveSessionId(null);
    }
  }

  function resizeSplit(splitId: string, ratio: number) {
    if (!activeProject || !activePage) return;
    updatePage(activeProject.id, activePage.id, (page) => ({
      ...page,
      root: updateSplitRatio(page.root, splitId, ratio),
    }));
  }

  function movePaneToPage(paneId: string, targetPageId: string) {
    if (!activeProject) return;
    const sourcePage = activePages.find((page) =>
      listPanes(page.root).some((pane) => pane.id === paneId),
    );
    const targetPage = activePages.find((page) => page.id === targetPageId);
    const pane = sourcePage
      ? listPanes(sourcePage.root).find((candidate) => candidate.id === paneId)
      : null;
    if (!sourcePage || !targetPage || !pane || sourcePage.id === targetPage.id) return;
    const sourceRoot = removePane(sourcePage.root, paneId);
    const targetPane = focusedPane(targetPage, activePaneByPage[targetPage.id]);
    const targetRoot: LayoutNode = targetPane
      ? (splitPane(targetPage.root, targetPane.id, {
          splitId: nextId("split", fallbackCounter),
          paneId: pane.id,
          sessionId: pane.sessionId,
          direction: "horizontal",
        }) ?? pane)
      : pane;
    setPagesByProject((current) => ({
      ...current,
      [activeProject.id]: (current[activeProject.id] ?? []).map((page) => {
        if (page.id === sourcePage.id) return { ...page, root: sourceRoot };
        if (page.id === targetPage.id) return { ...page, root: targetRoot };
        return page;
      }),
    }));
    const sourceNextPane = focusedPane(
      { ...sourcePage, root: sourceRoot },
      activePaneByPage[sourcePage.id],
    );
    setActivePaneByPage((current) => {
      const next = omitKey(current, sourcePage.id);
      if (sourceNextPane) next[sourcePage.id] = sourceNextPane.id;
      next[targetPage.id] = pane.id;
      return next;
    });
    focusPage(activeProject.id, { ...targetPage, root: targetRoot }, pane.id);
  }

  function movePaneToNextPage(paneId: string) {
    if (activePages.length < 2) return;
    const currentIndex = activePages.findIndex((page) => page.id === activePageId);
    const targetPage = activePages[(currentIndex + 1) % activePages.length];
    if (targetPage) movePaneToPage(paneId, targetPage.id);
  }

  function openSession(projectId: string, sessionId: string) {
    const project = projects.find((candidate) => candidate.id === projectId);
    if (!project?.sessions.some((session) => session.id === sessionId)) return;
    const projectPages = pagesByProject[projectId] ?? [];
    let page = projectPages.find((candidate) =>
      listPanes(candidate.root).some((pane) => pane.sessionId === sessionId),
    );
    if (!page) {
      page = createPage({
        pageId: nextId(`page-${projectId}`, fallbackCounter),
        title: nextPageTitle(projectPages),
        paneId: nextId("pane", fallbackCounter),
        sessionId,
      });
      setPagesByProject((current) => ({
        ...current,
        [projectId]: [...(current[projectId] ?? []), page as WorkspacePage],
      }));
    }
    const pane = listPanes(page.root).find((candidate) => candidate.sessionId === sessionId);
    setActiveProjectId(projectId);
    focusPage(projectId, page, pane?.id ?? null);
  }

  function cyclePage(direction: -1 | 1) {
    if (activePages.length < 2) return;
    const index = Math.max(
      0,
      activePages.findIndex((page) => page.id === activePageId),
    );
    selectPage(activePages[(index + direction + activePages.length) % activePages.length].id);
  }

  function cyclePane(direction: -1 | 1) {
    if (!activePage) return;
    const pane = cycleFocusedPane(activePage, activePane?.id, direction);
    if (pane) focusWorkspacePane(pane.id, pane.sessionId);
  }

  // Jump straight to the Nth pane of the current page, in layout order — the split-navigation
  // muscle memory from the original product's number keys.
  function focusPaneAt(index: number) {
    if (!activePage) return;
    const pane = listPanes(activePage.root)[index];
    if (pane) focusWorkspacePane(pane.id, pane.sessionId);
  }

  function installProject(project: Project, replacedPreviews: boolean) {
    const created = createInitialWorkspace([project], null);
    setPagesByProject((current) =>
      replacedPreviews ? created.pages : { ...current, ...created.pages },
    );
    setActivePageByProject((current) =>
      replacedPreviews ? created.active : { ...current, ...created.active },
    );
    setActivePaneByPage((current) =>
      replacedPreviews ? created.focused : { ...current, ...created.focused },
    );
    setActiveProjectId(project.id);
    setActiveSessionId(null);
  }

  function markLaunchHandled(sessionId: string) {
    setProjects((current) =>
      current.map((project) => {
        if (
          !project.sessions.some(
            (session) => session.id === sessionId && session.launchRequested === true,
          )
        ) {
          return project;
        }
        return {
          ...project,
          sessions: project.sessions.map((session) =>
            session.id === sessionId ? { ...session, launchRequested: false } : session,
          ),
        };
      }),
    );
  }

  function updateRuntimeObservation(sessionId: string, observation: TerminalRuntimeObservation) {
    setProjects((current) => applyRuntimeObservationToProjects(current, sessionId, observation));
  }

  return {
    activeProject,
    activeProjectId,
    activePages,
    activePageId,
    activePane,
    activeSession,
    activeSessionId,
    setActiveSessionId,
    selectProject,
    selectPage,
    focusWorkspacePane,
    createWorkspacePage,
    closeWorkspacePage,
    attachSession,
    createSessionInActivePage,
    splitActivePane,
    detachPane,
    resizeSplit,
    movePaneToPage,
    movePaneToNextPage,
    openSession,
    cyclePage,
    cyclePane,
    focusPaneAt,
    installProject,
    markLaunchHandled,
    updateRuntimeObservation,
  };
}

function makeSession(
  project: Project,
  index: number,
  launchRequested: boolean,
  counter: { current: number },
): DevSession {
  const profile = project.launchProfile.label.trim() || { kind: "default-profile" as const };
  return createWorkspaceSession({
    id: nextId("session", counter),
    title: { kind: "session-title", index },
    profile,
    launchProfile: project.launchProfile,
    branch: project.branch,
    createdAt: new Date().toISOString(),
    lastActivity: { kind: "session-created" },
    intro: { kind: "ready-intro" },
    outcome: { kind: "ready-outcome" },
    nextStep: { kind: "ready-next" },
    launchRequested,
  });
}

function nextId(prefix: string, counter: { current: number }): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}-${uuid}`;
  counter.current += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.current}`;
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([candidate]) => candidate !== key));
}

function nextPageTitle(pages: readonly WorkspacePage[]) {
  return nextGeneratedPageTitle(pages);
}
