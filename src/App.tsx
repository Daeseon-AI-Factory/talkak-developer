import { useEffect, useRef, useState } from "react";
import { presentationModeForWidth } from "./adaptiveLayout";
import { resolveAttentionRequest } from "./attentionModel";
import { AttentionCenter } from "./components/AttentionCenter";
import { ActivityView, SessionsView } from "./components/CollectionViews";
import { CommandPalette } from "./components/CommandPalette";
import { Icon } from "./components/Icon";
import { MobileDock } from "./components/MobileDock";
import { type MobileSessionTab, MobileSessionView } from "./components/MobileSessionView";
import { ProjectDialog } from "./components/ProjectDialog";
import { SettingsPanel } from "./components/SettingsPanel";
import { ShortcutGuide } from "./components/ShortcutGuide";
import { Sidebar } from "./components/Sidebar";
import { Workspace } from "./components/Workspace";
import { attentionRequests as demoAttentionRequests, projects as demoProjects } from "./demo";
import type { AppSection, AttentionRequest, InspectorMode, SidebarMode } from "./domain";
import { useI18n } from "./i18n";
import { platformFromUserAgent } from "./platform";
import { type ProjectDraft, browserProjectStorage } from "./projectStore";
import { createWorkspaceSession } from "./sessionModel";
import {
  type FeatureSettingId,
  type SettingScope,
  createDefaultSettingsState,
  effectiveSetting,
  setSettingOverride,
} from "./settingsModel";
import { shortcutDisplay } from "./shortcutRegistry";
import { useProjectRegistry } from "./useProjectRegistry";
import { useShortcutDispatcher } from "./useShortcutDispatcher";
import { useWorkspaceController } from "./useWorkspaceController";
import { hydrateWorkspaceProjects, readWorkspaceSnapshot } from "./workspaceStore";

export default function App() {
  const { locale, setLocale, t } = useI18n();
  const [workspaceSnapshot] = useState(() => readWorkspaceSnapshot(browserProjectStorage()));
  const projectRegistry = useProjectRegistry(demoProjects, (projects) =>
    hydrateWorkspaceProjects(projects, workspaceSnapshot, (project, metadata) =>
      createWorkspaceSession({
        id: metadata.id,
        title: metadata.title,
        profile: project.launchProfile.label || t("session.defaultProfile"),
        launchProfile: project.launchProfile,
        createdAt: metadata.createdAt,
        lastActivity: t("session.restored"),
        intro: t("session.restoredIntro"),
        outcome: t("session.restoredOutcome"),
        nextStep: t("session.restoredNext"),
        launchRequested: false,
      }),
    ),
  );
  const { projects, setProjects } = projectRegistry;
  const [presentationMode, setPresentationMode] = useState(() =>
    presentationModeForWidth(window.innerWidth),
  );
  const workspace = useWorkspaceController({
    projects,
    setProjects,
    presentationMode,
    snapshot: workspaceSnapshot,
    t,
  });
  const { activeProject, activePages, activePageId, activePane, activeSession, activeSessionId } =
    workspace;
  const initialAttentionRequests = projects.some((project) => project.source === "local")
    ? []
    : demoAttentionRequests;
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
  const [activeSection, setActiveSection] = useState<AppSection>(() =>
    presentationModeForWidth(window.innerWidth) === "phone" ? "attention" : "workspace",
  );
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>(readSidebarMode);
  const [focusMode, setFocusMode] = useState(false);
  const [inspectorMode, setInspectorMode] = useState<InspectorMode | null>(null);
  const [inspectorPinned, setInspectorPinned] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const platform = platformFromUserAgent(navigator.userAgent);
  const commandShortcut = shortcutDisplay(platform, "palette");
  const guideShortcut = shortcutDisplay(platform, "guide");
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
    try {
      localStorage.setItem("talkak.sidebarMode", sidebarMode);
    } catch {
      // The layout remains usable when persistence is unavailable.
    }
  }, [sidebarMode]);

  function selectProject(projectId: string) {
    workspace.selectProject(projectId);
    setActiveSection("workspace");
    setInspectorMode(null);
  }

  function openSession(projectId: string, sessionId: string) {
    workspace.openSession(projectId, sessionId);
    setActiveSection("workspace");
    setInspectorMode("summary");
  }

  function saveProject(draft: ProjectDraft) {
    const result = projectRegistry.saveProject(draft);
    if (!result.created) return;
    workspace.installProject(result.project, result.replacedPreviews);
    if (result.replacedPreviews) {
      attentionRequestsRef.current = [];
      setAttentionRequests([]);
    }
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
    workspace.selectProject(projectId);
    workspace.setActiveSessionId(sessionId);
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

  useShortcutDispatcher({
    platform,
    workspaceEnabled: activeSection === "workspace" && presentationMode !== "phone",
    disabled: commandOpen || shortcutsOpen || projectRegistry.editorOpen,
    handlers: {
      palette: () => {
        setShortcutsOpen(false);
        setCommandOpen(true);
      },
      guide: () => {
        setCommandOpen(false);
        setShortcutsOpen(true);
      },
      settings: () => setActiveSection("settings"),
      newPage: workspace.createWorkspacePage,
      splitRight: () => activePane && workspace.splitActivePane(activePane.id, "horizontal"),
      splitDown: () => activePane && workspace.splitActivePane(activePane.id, "vertical"),
      closePane: () => activePane && workspace.detachPane(activePane.id),
      summary: () => {
        if (activeSession)
          setInspectorMode((current) => (current === "summary" ? null : "summary"));
      },
      terminalLog: () => {
        if (activeSession) {
          setInspectorMode((current) => (current === "terminal" ? null : "terminal"));
        }
      },
      previousPage: () => workspace.cyclePage(-1),
      nextPage: () => workspace.cyclePage(1),
      previousPane: () => workspace.cyclePane(-1),
      nextPane: () => workspace.cyclePane(1),
    },
  });

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
        settingsShortcut={shortcutDisplay(platform, "settings")}
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
            <button
              className="command-search"
              type="button"
              onClick={() => {
                setShortcutsOpen(false);
                setCommandOpen(true);
              }}
            >
              <Icon name="search" size={15} />
              <span>{t("utility.search")}</span>
              <kbd>{commandShortcut}</kbd>
            </button>
          </div>
          <div className="app-utilitybar__actions">
            <button
              className="shell-control shell-control--label"
              type="button"
              title={`${t("utility.shortcuts")} · ${guideShortcut}`}
              onClick={() => {
                setCommandOpen(false);
                setShortcutsOpen(true);
              }}
            >
              <Icon name="command" size={15} />
              <span>{t("utility.shortcuts")}</span>
              <kbd>{guideShortcut}</kbd>
            </button>
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
            onSelectSession={workspace.setActiveSessionId}
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
            activePaneId={activePane?.id ?? null}
            activeSessionId={activeSessionId}
            platform={platform}
            inspectorMode={inspectorMode}
            inspectorPinned={inspectorPinned}
            maxPaneCount={presentationMode === "tablet" ? 2 : undefined}
            onSelectSession={workspace.setActiveSessionId}
            onSelectPane={workspace.focusWorkspacePane}
            onSelectPage={workspace.selectPage}
            onCreatePage={workspace.createWorkspacePage}
            onClosePage={workspace.closeWorkspacePage}
            onMovePaneToPage={workspace.movePaneToPage}
            onMovePaneToNextPage={workspace.movePaneToNextPage}
            onAttachSession={workspace.attachSession}
            onCreateSessionInPage={workspace.createSessionInActivePage}
            onSplitPane={workspace.splitActivePane}
            onDetachPane={workspace.detachPane}
            onResizeSplit={workspace.resizeSplit}
            onOpenInspector={setInspectorMode}
            onCloseInspector={() => setInspectorMode(null)}
            onToggleInspectorPin={() => setInspectorPinned((current) => !current)}
            onLaunchHandled={workspace.markLaunchHandled}
            onPhaseChange={workspace.updateRuntimePhase}
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
      <ShortcutGuide
        open={shortcutsOpen}
        platform={platform}
        onClose={() => setShortcutsOpen(false)}
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

function readSidebarMode(): SidebarMode {
  try {
    const stored = localStorage.getItem("talkak.sidebarMode");
    return stored === "rail" || stored === "hidden" ? stored : "expanded";
  } catch {
    return "expanded";
  }
}
