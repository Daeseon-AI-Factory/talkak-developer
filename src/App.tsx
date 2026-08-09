import { useEffect, useMemo, useRef, useState } from "react";
import { presentationModeForWidth } from "./adaptiveLayout";
import { resolveAttentionRequest } from "./attentionModel";
import { AttentionCenter } from "./components/AttentionCenter";
import { ActivityView, SessionsView, createPreviewSession } from "./components/CollectionViews";
import { CommandPalette } from "./components/CommandPalette";
import { Icon } from "./components/Icon";
import { MobileDock } from "./components/MobileDock";
import { type MobileSessionTab, MobileSessionView } from "./components/MobileSessionView";
import { ProjectDialog } from "./components/ProjectDialog";
import { SettingsPanel } from "./components/SettingsPanel";
import { Sidebar } from "./components/Sidebar";
import { Workspace } from "./components/Workspace";
import { attentionRequests as demoAttentionRequests, projects as demoProjects } from "./demo";
import type { AppSection, AttentionRequest, InspectorMode, Project, SidebarMode } from "./domain";
import { useI18n } from "./i18n";
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
import { platformFromUserAgent, shortcutLabel } from "./platform";
import type { ProjectDraft } from "./projectStore";
import {
  type FeatureSettingId,
  type SettingScope,
  createDefaultSettingsState,
  effectiveSetting,
  setSettingOverride,
} from "./settingsModel";
import { useProjectRegistry } from "./useProjectRegistry";

type ProjectPages = Record<string, WorkspacePage[]>;
type ActivePages = Record<string, string>;

export default function App() {
  const { locale, setLocale, t } = useI18n();
  const projectRegistry = useProjectRegistry(demoProjects);
  const { projects, setProjects } = projectRegistry;
  const [initialPages] = useState(() => createInitialPages(projects));
  const initialAttentionRequests = projects.some((project) => project.source === "local")
    ? []
    : demoAttentionRequests;
  const [presentationMode, setPresentationMode] = useState(() =>
    presentationModeForWidth(window.innerWidth),
  );
  const [attentionRequests, setAttentionRequests] =
    useState<AttentionRequest[]>(initialAttentionRequests);
  const attentionRequestsRef = useRef<AttentionRequest[]>(initialAttentionRequests);
  const [selectedAttentionId, setSelectedAttentionId] = useState<string | null>(null);
  const [settings, setSettings] = useState(createDefaultSettingsState);
  const [draftsBySession, setDraftsBySession] = useState<Record<string, string>>({});
  const [mobileTabsBySession, setMobileTabsBySession] = useState<Record<string, MobileSessionTab>>(
    {},
  );
  const [reviewedDraftsBySession, setReviewedDraftsBySession] = useState<
    Record<string, string | undefined>
  >({});
  const [pagesByProject, setPagesByProject] = useState<ProjectPages>(initialPages.pages);
  const [activePageByProject, setActivePageByProject] = useState<ActivePages>(initialPages.active);
  const [activeProjectId, setActiveProjectId] = useState(projects[0].id);
  const [activeSection, setActiveSection] = useState<AppSection>(() =>
    presentationModeForWidth(window.innerWidth) === "phone" ? "attention" : "workspace",
  );
  const [activeSessionId, setActiveSessionId] = useState<string | null>(
    projects[0].sessions[0]?.id ?? null,
  );
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>(readSidebarMode);
  const [focusMode, setFocusMode] = useState(false);
  const [inspectorMode, setInspectorMode] = useState<InspectorMode | null>(null);
  const [inspectorPinned, setInspectorPinned] = useState(false);
  const [previewSessionCount, setPreviewSessionCount] = useState(0);
  const [commandOpen, setCommandOpen] = useState(false);
  const entityCounter = useRef(0);
  const commandShortcut = shortcutLabel(platformFromUserAgent(navigator.userAgent), "k");

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? projects[0],
    [activeProjectId, projects],
  );
  const activePages = pagesByProject[activeProject.id] ?? [];
  const activePageId = activePageByProject[activeProject.id] ?? activePages[0]?.id ?? "";
  const activeSession =
    activeProject.sessions.find((session) => session.id === activeSessionId) ??
    activeProject.sessions[0] ??
    null;
  const openAttentionCount = attentionRequests.filter(
    (request) => request.status === "open",
  ).length;
  const voiceEnabled = effectiveSetting(settings, "voiceInput", {
    projectId: activeProject.id,
    sessionId: activeSession?.id,
  });

  useEffect(() => {
    const updatePresentation = () =>
      setPresentationMode(presentationModeForWidth(window.innerWidth));
    updatePresentation();
    window.addEventListener("resize", updatePresentation);
    return () => window.removeEventListener("resize", updatePresentation);
  }, []);

  useEffect(() => {
    if (presentationMode === "phone" || !activeSessionId) return;
    const project = projects.find((candidate) => candidate.id === activeProjectId);
    const session = project?.sessions.find((candidate) => candidate.id === activeSessionId);
    if (!project || !session) return;

    const currentPages = pagesByProject[activeProjectId] ?? [];
    const matchingPage = currentPages.find((page) =>
      listPanes(page.root).some((pane) => pane.sessionId === activeSessionId),
    );
    const pageId = matchingPage?.id ?? `page-${activeProjectId}-${activeSessionId}`;

    if (!matchingPage) {
      const page = createPage({
        pageId,
        title: session.title,
        paneId: `pane-${activeSessionId}`,
        sessionId: activeSessionId,
      });
      setPagesByProject((current) => {
        const pages = current[activeProjectId] ?? [];
        if (pages.some((candidate) => candidate.id === pageId)) return current;
        return { ...current, [activeProjectId]: [...pages, page] };
      });
    }

    setActivePageByProject((current) =>
      current[activeProjectId] === pageId ? current : { ...current, [activeProjectId]: pageId },
    );
  }, [activeProjectId, activeSessionId, pagesByProject, presentationMode, projects]);

  useEffect(() => {
    const openCommandPalette = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLocaleLowerCase() !== "k") return;
      event.preventDefault();
      event.stopPropagation();
      setCommandOpen(true);
    };
    window.addEventListener("keydown", openCommandPalette, true);
    return () => window.removeEventListener("keydown", openCommandPalette, true);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("talkak.sidebarMode", sidebarMode);
    } catch {
      // The layout remains usable when persistence is unavailable.
    }
  }, [sidebarMode]);

  function nextId(prefix: string) {
    entityCounter.current += 1;
    return `${prefix}-${entityCounter.current}`;
  }

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

  function selectProject(projectId: string) {
    const project = projects.find((candidate) => candidate.id === projectId);
    if (!project) return;
    const pages = pagesByProject[projectId] ?? [];
    const pageId = activePageByProject[projectId] ?? pages[0]?.id;
    const page = pages.find((candidate) => candidate.id === pageId) ?? pages[0];
    setActiveProjectId(projectId);
    setActiveSessionId(listPanes(page?.root ?? null)[0]?.sessionId ?? null);
    setActiveSection("workspace");
    setInspectorMode(null);
  }

  function selectPage(pageId: string) {
    const page = activePages.find((candidate) => candidate.id === pageId);
    if (!page) return;
    setActivePageByProject((current) => ({ ...current, [activeProject.id]: pageId }));
    setActiveSessionId(listPanes(page.root)[0]?.sessionId ?? null);
  }

  function createWorkspacePage() {
    const page: WorkspacePage = {
      id: nextId(`page-${activeProject.id}`),
      title: `Page ${activePages.length + 1}`,
      root: null,
    };
    setPagesByProject((current) => ({
      ...current,
      [activeProject.id]: [...(current[activeProject.id] ?? []), page],
    }));
    setActivePageByProject((current) => ({ ...current, [activeProject.id]: page.id }));
    setActiveSessionId(null);
    setInspectorMode(null);
  }

  function closeWorkspacePage(pageId: string) {
    if (activePages.length <= 1) return;
    const removedIndex = activePages.findIndex((page) => page.id === pageId);
    const nextPages = activePages.filter((page) => page.id !== pageId);
    setPagesByProject((current) => ({ ...current, [activeProject.id]: nextPages }));
    if (pageId !== activePageId) return;
    const nextPage = nextPages[Math.min(Math.max(removedIndex, 0), nextPages.length - 1)];
    setActivePageByProject((current) => ({ ...current, [activeProject.id]: nextPage.id }));
    setActiveSessionId(listPanes(nextPage.root)[0]?.sessionId ?? null);
    setInspectorMode(null);
  }

  function attachSession(sessionId: string) {
    updatePage(activeProject.id, activePageId, (page) => ({
      ...page,
      title: page.title.startsWith("Page ")
        ? (activeProject.sessions.find((session) => session.id === sessionId)?.title ?? page.title)
        : page.title,
      root: { kind: "pane", id: nextId("pane"), sessionId },
    }));
    setActiveSessionId(sessionId);
  }

  function splitActivePane(paneId: string, direction: SplitDirection) {
    const page = activePages.find((candidate) => candidate.id === activePageId);
    if (!page) return;
    if (presentationMode === "tablet" && listPanes(page.root).length >= 2) return;
    const attached = new Set(listPanes(page.root).map((pane) => pane.sessionId));
    let session = activeProject.sessions.find((candidate) => !attached.has(candidate.id));

    if (!session) {
      const nextIndex = previewSessionCount + 1;
      const preview = createPreviewSession(nextIndex, locale, activeProject.launchProfile);
      setPreviewSessionCount(nextIndex);
      setProjects((current) =>
        current.map((project) =>
          project.id === activeProject.id
            ? { ...project, sessions: [...project.sessions, preview] }
            : project,
        ),
      );
      session = preview;
    }

    const sessionId = session.id;
    updatePage(activeProject.id, activePageId, (currentPage) => ({
      ...currentPage,
      root: splitPane(currentPage.root, paneId, {
        splitId: nextId("split"),
        paneId: nextId("pane"),
        sessionId,
        direction,
      }),
    }));
    setActiveSessionId(sessionId);
  }

  function detachPane(paneId: string) {
    const page = activePages.find((candidate) => candidate.id === activePageId);
    const nextRoot = removePane(page?.root ?? null, paneId);
    updatePage(activeProject.id, activePageId, (currentPage) => ({
      ...currentPage,
      root: nextRoot,
    }));
    const nextSessionId = listPanes(nextRoot)[0]?.sessionId ?? null;
    setActiveSessionId(nextSessionId);
    if (!nextSessionId) setInspectorMode(null);
  }

  function resizeSplit(splitId: string, ratio: number) {
    updatePage(activeProject.id, activePageId, (page) => ({
      ...page,
      root: updateSplitRatio(page.root, splitId, ratio),
    }));
  }

  function movePaneToPage(paneId: string, targetPageId: string) {
    const sourcePage = activePages.find((page) =>
      listPanes(page.root).some((pane) => pane.id === paneId),
    );
    const targetPage = activePages.find((page) => page.id === targetPageId);
    const pane = sourcePage
      ? listPanes(sourcePage.root).find((candidate) => candidate.id === paneId)
      : null;
    if (!sourcePage || !targetPage || !pane || sourcePage.id === targetPage.id) return;

    const sourceRoot = removePane(sourcePage.root, paneId);
    const firstTargetPane = listPanes(targetPage.root)[0];
    const targetRoot: LayoutNode = firstTargetPane
      ? (splitPane(targetPage.root, firstTargetPane.id, {
          splitId: nextId("split"),
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
    setActivePageByProject((current) => ({ ...current, [activeProject.id]: targetPage.id }));
    setActiveSessionId(pane.sessionId);
  }

  function movePaneToNextPage(paneId: string) {
    const currentIndex = activePages.findIndex((page) => page.id === activePageId);
    const targetPage = activePages[(currentIndex + 1) % activePages.length];
    if (targetPage) movePaneToPage(paneId, targetPage.id);
  }

  function openSession(projectId: string, sessionId: string) {
    const projectPages = pagesByProject[projectId] ?? [];
    let page = projectPages.find((candidate) =>
      listPanes(candidate.root).some((pane) => pane.sessionId === sessionId),
    );

    if (!page) {
      page = createPage({
        pageId: nextId(`page-${projectId}`),
        title:
          projects
            .find((project) => project.id === projectId)
            ?.sessions.find((session) => session.id === sessionId)?.title ?? "Session",
        paneId: nextId("pane"),
        sessionId,
      });
      setPagesByProject((current) => ({
        ...current,
        [projectId]: [...(current[projectId] ?? []), page as WorkspacePage],
      }));
    }

    setActiveProjectId(projectId);
    setActivePageByProject((current) => ({ ...current, [projectId]: page.id }));
    setActiveSessionId(sessionId);
    setActiveSection("workspace");
    setInspectorMode("summary");
  }

  function createSession() {
    const nextIndex = previewSessionCount + 1;
    const nextSession = createPreviewSession(nextIndex, locale, activeProject.launchProfile);
    const nextPage = createPage({
      pageId: nextId(`page-${activeProject.id}`),
      title: nextSession.title,
      paneId: nextId("pane"),
      sessionId: nextSession.id,
    });
    setPreviewSessionCount(nextIndex);
    setProjects((current) =>
      current.map((project) =>
        project.id === activeProject.id
          ? { ...project, sessions: [...project.sessions, nextSession] }
          : project,
      ),
    );
    setPagesByProject((current) => ({
      ...current,
      [activeProject.id]: [...(current[activeProject.id] ?? []), nextPage],
    }));
    setActivePageByProject((current) => ({ ...current, [activeProject.id]: nextPage.id }));
    setActiveSessionId(nextSession.id);
    setInspectorMode("summary");
  }

  function saveProject(draft: ProjectDraft) {
    const result = projectRegistry.saveProject(draft);
    if (!result.created) return;
    const createdPages = createInitialPages([result.project]);
    setPagesByProject((current) =>
      result.replacedPreviews ? createdPages.pages : { ...current, ...createdPages.pages },
    );
    setActivePageByProject((current) =>
      result.replacedPreviews ? createdPages.active : { ...current, ...createdPages.active },
    );
    if (result.replacedPreviews) {
      attentionRequestsRef.current = [];
      setAttentionRequests([]);
    }
    setActiveProjectId(result.project.id);
    setActiveSessionId(null);
    setActiveSection("workspace");
    setInspectorMode(null);
  }

  function resolveAttention(requestId: string, revision: number, choiceId: string) {
    const result = resolveAttentionRequest(
      attentionRequestsRef.current,
      requestId,
      revision,
      choiceId,
      new Date().toISOString(),
    );
    if (!result.ok) return false;
    attentionRequestsRef.current = result.state;
    setAttentionRequests(result.state);
    return true;
  }

  function openAttentionSession(projectId: string, sessionId: string) {
    if (presentationMode !== "phone") {
      openSession(projectId, sessionId);
      return;
    }
    const project = projects.find((candidate) => candidate.id === projectId);
    if (!project?.sessions.some((session) => session.id === sessionId)) return;
    setActiveProjectId(projectId);
    setActiveSessionId(sessionId);
    setActiveSection("workspace");
  }

  function updateSetting(
    scope: SettingScope,
    targetId: string | null,
    id: FeatureSettingId,
    value: boolean | null,
  ) {
    setSettings((current) => setSettingOverride(current, scope, targetId, id, value));
  }

  function updateDraft(sessionId: string, value: string) {
    setDraftsBySession((current) => ({ ...current, [sessionId]: value }));
    setReviewedDraftsBySession((current) => {
      if (current[sessionId] === undefined) return current;
      return { ...current, [sessionId]: undefined };
    });
  }

  function cycleSidebar() {
    setSidebarMode((current) =>
      current === "expanded" ? "rail" : current === "rail" ? "hidden" : "expanded",
    );
  }

  return (
    <div
      className="app-shell"
      data-sidebar-mode={sidebarMode}
      data-focus-mode={focusMode}
      data-presentation={presentationMode}
    >
      <Sidebar
        projects={projects}
        activeProjectId={activeProject.id}
        activeSection={activeSection}
        mode={sidebarMode}
        onSelectProject={selectProject}
        onSelectSection={setActiveSection}
        onAddProject={projectRegistry.openProjectCreator}
        onEditProject={projectRegistry.openProjectEditor}
        settingsShortcut={shortcutLabel(platformFromUserAgent(navigator.userAgent), ",")}
      />

      <main className="app-main">
        <div className="app-utilitybar">
          <div className="app-utilitybar__leading">
            <button
              className="shell-control"
              type="button"
              aria-label={t("shell.toggleSidebar")}
              title={t("shell.toggleSidebar")}
              onClick={cycleSidebar}
            >
              <Icon name="panel" size={16} />
            </button>
            <button className="command-search" type="button" onClick={() => setCommandOpen(true)}>
              <Icon name="search" size={15} />
              <span>{t("utility.search")}</span>
              <kbd>{commandShortcut}</kbd>
            </button>
          </div>
          <div className="app-utilitybar__actions">
            <button
              className="shell-control shell-control--label"
              type="button"
              data-active={focusMode}
              aria-pressed={focusMode}
              onClick={() => {
                setFocusMode((current) => !current);
                setInspectorMode(null);
              }}
            >
              <Icon name="focus" size={15} />
              <span>{focusMode ? t("shell.exitFocus") : t("shell.focus")}</span>
            </button>
            <div className="language-switch" aria-label={t("utility.language")}>
              <button
                type="button"
                data-active={locale === "ko"}
                aria-pressed={locale === "ko"}
                onClick={() => setLocale("ko")}
              >
                한국어
              </button>
              <button
                type="button"
                data-active={locale === "en"}
                aria-pressed={locale === "en"}
                onClick={() => setLocale("en")}
              >
                EN
              </button>
            </div>
            <span className="preview-mode">{t("utility.foundation")}</span>
          </div>
        </div>

        {activeSection === "attention" ? (
          <AttentionCenter
            requests={attentionRequests}
            projects={projects}
            selectedRequestId={selectedAttentionId}
            onSelectRequest={setSelectedAttentionId}
            onResolve={resolveAttention}
            onOpenSession={openAttentionSession}
          />
        ) : null}

        {activeSection === "workspace" && presentationMode === "phone" ? (
          <MobileSessionView
            project={activeProject}
            session={activeSession}
            draft={activeSession ? (draftsBySession[activeSession.id] ?? "") : ""}
            activeTab={
              activeSession
                ? (mobileTabsBySession[activeSession.id] ?? "conversation")
                : "conversation"
            }
            reviewedDraft={
              activeSession ? (reviewedDraftsBySession[activeSession.id] ?? null) : null
            }
            voiceEnabled={voiceEnabled}
            onDraftChange={(value) => {
              if (activeSession) updateDraft(activeSession.id, value);
            }}
            onSelectSession={setActiveSessionId}
            onSelectTab={(tab) => {
              if (!activeSession) return;
              setMobileTabsBySession((current) => ({ ...current, [activeSession.id]: tab }));
            }}
            onReviewDraft={() => {
              if (!activeSession) return;
              const draft = draftsBySession[activeSession.id] ?? "";
              setReviewedDraftsBySession((current) => ({
                ...current,
                [activeSession.id]: draft,
              }));
            }}
            onEditDraft={() => {
              if (!activeSession) return;
              setReviewedDraftsBySession((current) => ({
                ...current,
                [activeSession.id]: undefined,
              }));
            }}
            onOpenSettings={() => setActiveSection("settings")}
          />
        ) : null}

        {activeSection === "workspace" && presentationMode !== "phone" ? (
          <Workspace
            project={activeProject}
            pages={activePages}
            activePageId={activePageId}
            activeSessionId={activeSessionId}
            inspectorMode={inspectorMode}
            inspectorPinned={inspectorPinned}
            maxPaneCount={presentationMode === "tablet" ? 2 : undefined}
            onSelectSession={setActiveSessionId}
            onSelectPage={selectPage}
            onCreatePage={createWorkspacePage}
            onClosePage={closeWorkspacePage}
            onMovePaneToPage={movePaneToPage}
            onMovePaneToNextPage={movePaneToNextPage}
            onAttachSession={attachSession}
            onSplitPane={splitActivePane}
            onDetachPane={detachPane}
            onResizeSplit={resizeSplit}
            onOpenInspector={setInspectorMode}
            onCloseInspector={() => setInspectorMode(null)}
            onToggleInspectorPin={() => setInspectorPinned((current) => !current)}
            onCreateSession={createSession}
          />
        ) : null}

        {activeSection === "sessions" ? (
          <SessionsView projects={projects} onOpenSession={openAttentionSession} />
        ) : null}

        {activeSection === "activity" ? (
          <ActivityView projects={projects} onOpenSession={openAttentionSession} />
        ) : null}

        {activeSection === "settings" ? (
          <SettingsPanel
            state={settings}
            projectId={activeProject.id}
            sessionId={activeSession?.id ?? null}
            onSetOverride={updateSetting}
          />
        ) : null}
      </main>
      {presentationMode === "phone" ? (
        <MobileDock
          activeSection={activeSection}
          attentionCount={openAttentionCount}
          onSelectSection={setActiveSection}
        />
      ) : null}
      <CommandPalette
        open={commandOpen}
        projects={projects}
        onClose={() => setCommandOpen(false)}
        onOpenSession={openAttentionSession}
        onOpenProject={selectProject}
      />
      <ProjectDialog
        open={projectRegistry.editorOpen}
        project={projectRegistry.editingProject}
        onClose={projectRegistry.closeProjectEditor}
        onSave={saveProject}
      />
    </div>
  );
}

function createInitialPages(projects: readonly Project[]) {
  const pages: ProjectPages = {};
  const active: ActivePages = {};
  for (const project of projects) {
    const firstSession = project.sessions[0];
    const page = firstSession
      ? createPage({
          pageId: `page-${project.id}-1`,
          title: firstSession.title,
          paneId: `pane-${firstSession.id}`,
          sessionId: firstSession.id,
        })
      : { id: `page-${project.id}-1`, title: "Page 1", root: null };
    pages[project.id] = [page];
    active[project.id] = page.id;
  }
  return { pages, active };
}

function readSidebarMode(): SidebarMode {
  try {
    const stored = localStorage.getItem("talkak.sidebarMode");
    return stored === "rail" || stored === "hidden" ? stored : "expanded";
  } catch {
    return "expanded";
  }
}
