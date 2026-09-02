import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { presentationModeForWidth } from "./adaptiveLayout";
import { resolveAttentionRequest } from "./attentionModel";
import { AttentionCenter } from "./components/AttentionCenter";
import { BackgroundSessionRuntimes } from "./components/BackgroundSessionRuntimes";
import { ActivityView, SessionsView } from "./components/CollectionViews";
import { CommandPalette } from "./components/CommandPalette";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { Icon } from "./components/Icon";
import { MobileDock } from "./components/MobileDock";
import { type MobileSessionTab, MobileSessionView } from "./components/MobileSessionView";
import { ProjectDeleteDialog } from "./components/ProjectDeleteDialog";
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
import type { RuntimeAttentionNotice } from "./runtime/runtimeAttentionModel";
import { foregroundTerminalSessionIds } from "./runtime/sessionVisibility";
import { useRuntimeNotices } from "./runtime/useRuntimeNotices";
import { createWorkspaceSession } from "./sessionModel";
import {
  type FeatureSettingId,
  type SettingScope,
  createDefaultSettingsState,
  effectiveSetting,
  setSettingOverride,
} from "./settingsModel";
import { shortcutDisplay } from "./shortcutRegistry";
import { applyThemeToRetainedTerminals } from "./terminalInstances";
import { applyThemeToRetainedTerminalLogs } from "./terminalLogInstances";
import { jumpTerminalToBottom, toggleTerminalScrollMode } from "./terminalScrollMode";
import { subscribeTerminalTheme } from "./terminalTheme";
import { useCloseConfirmations } from "./useCloseConfirmations";
import { useProjectActions } from "./useProjectActions";
import { useProjectRegistry } from "./useProjectRegistry";
import { useQuitConfirmation } from "./useQuitConfirmation";
import { useShortcutDispatcher } from "./useShortcutDispatcher";
import { useWorkspaceController } from "./useWorkspaceController";
import { hydrateWorkspaceProjects, readWorkspaceSnapshot } from "./workspaceStore";

export default function App() {
  const { locale, setLocale, t, text } = useI18n();
  const [workspaceSnapshot] = useState(() => readWorkspaceSnapshot(browserProjectStorage()));
  const projectRegistry = useProjectRegistry(demoProjects, (projects) =>
    hydrateWorkspaceProjects(projects, workspaceSnapshot, (project, metadata) =>
      createWorkspaceSession({
        id: metadata.id,
        title: metadata.title,
        profile: project.launchProfile.label || { kind: "default-profile" },
        launchProfile: project.launchProfile,
        branch: project.branch,
        createdAt: metadata.createdAt,
        lastActivity: { kind: "session-restored" },
        intro: { kind: "restored-intro" },
        outcome: { kind: "restored-outcome" },
        nextStep: { kind: "restored-next" },
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
  const sidebarShortcut = shortcutDisplay(platform, "toggleSidebar");
  const { runtimeNotices, acknowledgeRuntimeNotice: dismissRuntimeNotice } = useRuntimeNotices({
    projects,
    settings,
    focusedSessionId: activeSection === "workspace" ? activeSessionId : null,
  });
  const openAttentionCount =
    attentionRequests.filter((request) => request.status === "open").length + runtimeNotices.length;
  const voiceEnabled = effectiveSetting(settings, "voiceInput", {
    projectId: activeProject.id,
    sessionId: activeSession?.id,
  });
  const foregroundSessionIds = new Set(
    activeSection === "workspace" && presentationMode !== "phone"
      ? foregroundTerminalSessionIds(
          activePages,
          activePageId,
          activeSessionId,
          presentationMode === "tablet" ? 2 : undefined,
        )
      : [],
  );

  useEffect(() => {
    const updatePresentation = () =>
      setPresentationMode(presentationModeForWidth(window.innerWidth));
    updatePresentation();
    window.addEventListener("resize", updatePresentation);
    return () => window.removeEventListener("resize", updatePresentation);
  }, []);

  // Every terminal — live panes and the read-only log — repaints the moment the theme preset
  // changes, instead of waiting for the next mount. One subscription for the whole app: the
  // retained emulators live outside any single component and outlive page switches.
  useEffect(
    () =>
      subscribeTerminalTheme((preset) => {
        applyThemeToRetainedTerminals(preset.theme, preset.minimumContrastRatio);
        applyThemeToRetainedTerminalLogs(preset.theme, preset.minimumContrastRatio);
      }),
    [],
  );

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

  const projectActions = useProjectActions({
    projects,
    activeSession,
    removeProject: (projectId) => projectRegistry.removeProject(projectId),
    updateRuntimeObservation: workspace.updateRuntimeObservation,
    selectProject,
  });

  const {
    closingPage,
    closingImpact,
    paneToDetach,
    detachingSession,
    requestDetachPane,
    requestClosePage,
    cancelDetach,
    confirmDetach,
    cancelClose,
    confirmClose,
  } = useCloseConfirmations({
    activeProject,
    activePages,
    detachPane: workspace.detachPane,
    closeWorkspacePage: workspace.closeWorkspacePage,
  });

  const { quitKills, setQuitKills } = useQuitConfirmation(projects);

  function cycleProject(direction: -1 | 1) {
    if (projects.length < 2) return;
    const index = projects.findIndex((project) => project.id === activeProject.id);
    const next = projects[(index + direction + projects.length) % projects.length];
    selectProject(next.id);
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

  function openRuntimeSession(projectId: string, sessionId: string) {
    if (presentationMode === "phone") {
      const project = projects.find((candidate) => candidate.id === projectId);
      if (!project?.sessions.some((session) => session.id === sessionId)) return;
      workspace.selectProject(projectId);
      workspace.setActiveSessionId(sessionId);
      setMobileTabsBySession((current) => ({ ...current, [sessionId]: "terminal" }));
      setActiveSection("workspace");
      return;
    }
    workspace.openSession(projectId, sessionId);
    setActiveSection("workspace");
    setInspectorMode("terminal");
  }

  function acknowledgeRuntimeNotice(notice: RuntimeAttentionNotice) {
    dismissRuntimeNotice(notice);
    if (selectedAttentionId === notice.id) setSelectedAttentionId(null);
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
      toggleSidebar: cycleSidebar,
      previousProject: () => cycleProject(-1),
      nextProject: () => cycleProject(1),
      newPage: workspace.createWorkspacePage,
      splitRight: () => activePane && workspace.splitActivePane(activePane.id, "horizontal"),
      splitDown: () => activePane && workspace.splitActivePane(activePane.id, "vertical"),
      closePane: () => activePane && requestDetachPane(activePane.id),
      summary: () => {
        if (activeSession)
          setInspectorMode((current) => (current === "summary" ? null : "summary"));
      },
      terminalLog: () => {
        if (activeSession) {
          setInspectorMode((current) => (current === "terminal" ? null : "terminal"));
        }
      },
      conversation: () => {
        if (activeSession) {
          setInspectorMode((current) => (current === "conversation" ? null : "conversation"));
        }
      },
      previousPage: () => workspace.cyclePage(-1),
      nextPage: () => workspace.cyclePage(1),
      previousPane: () => workspace.cyclePane(-1),
      nextPane: () => workspace.cyclePane(1),
      scrollMode: () => {
        if (activeSession) toggleTerminalScrollMode(activeSession.id);
      },
      jumpToBottom: () => {
        if (activeSession) jumpTerminalToBottom(activeSession.id);
      },
      ...Object.fromEntries(
        Array.from({ length: 9 }, (_, index) => [
          `focusPane${index + 1}`,
          () => workspace.focusPaneAt(index),
        ]),
      ),
      ...Object.fromEntries(
        Array.from({ length: 9 }, (_, index) => [
          `focusProject${index + 1}`,
          () => projectActions.focusProject(index),
        ]),
      ),
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
        attentionCount={openAttentionCount}
        mode={sidebarMode}
        platform={platform}
        onSelectProject={selectProject}
        onSelectSection={setActiveSection}
        onAddProject={projectRegistry.openProjectCreator}
        onEditProject={projectRegistry.openProjectEditor}
        onMoveProject={projectRegistry.moveProject}
        onDeleteProject={projectActions.requestDeleteProject}
        onRevealProject={projectActions.revealProject}
        settingsShortcut={shortcutDisplay(platform, "settings")}
      />

      <main className="app-main">
        <div className="app-utilitybar">
          <div className="app-utilitybar__leading">
            <button
              className="shell-control shell-control--sidebar-toggle"
              type="button"
              aria-label={t("shell.toggleSidebar")}
              title={`${t("shell.toggleSidebar")} · ${sidebarShortcut}`}
              onClick={cycleSidebar}
            >
              <Icon name="panel" size={16} />
              {/* Covers the icon on hover instead of sitting beside it, so a 32px control stays
                  32px and the key is still there to be learned. */}
              <kbd>{sidebarShortcut}</kbd>
            </button>
            <button
              className="shell-control shell-control--project"
              type="button"
              data-testid="add-project-global"
              aria-label={t("sidebar.addProject")}
              title={t("sidebar.addProject")}
              onClick={projectRegistry.openProjectCreator}
            >
              <Icon name="plus" size={16} />
            </button>
            <button
              className="shell-control shell-control--project"
              type="button"
              aria-label={t("sidebar.editProject")}
              title={t("sidebar.editProject")}
              disabled={activeProject.source !== "local"}
              onClick={() => projectRegistry.openProjectEditor(activeProject.id)}
            >
              <Icon name="settings" size={15} />
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
            runtimeNotices={runtimeNotices}
            projects={projects}
            selectedRequestId={selectedAttentionId}
            onSelectRequest={setSelectedAttentionId}
            onResolve={resolveAttention}
            onOpenSession={openAttentionSession}
            onOpenRuntimeSession={openRuntimeSession}
            onAcknowledgeRuntimeNotice={acknowledgeRuntimeNotice}
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
            onClosePage={requestClosePage}
            onMovePaneToPage={workspace.movePaneToPage}
            onMovePaneToNextPage={workspace.movePaneToNextPage}
            onAttachSession={workspace.attachSession}
            onCreateSessionInPage={workspace.createSessionInActivePage}
            onSplitPane={workspace.splitActivePane}
            onDetachPane={requestDetachPane}
            onResizeSplit={workspace.resizeSplit}
            onOpenInspector={setInspectorMode}
            onCloseInspector={() => setInspectorMode(null)}
            onToggleInspectorPin={() => setInspectorPinned((current) => !current)}
            onLaunchHandled={workspace.markLaunchHandled}
            onRename={workspace.renameSession}
            onRuntimeObservation={workspace.updateRuntimeObservation}
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
      <BackgroundSessionRuntimes
        projects={projects}
        foregroundSessionIds={foregroundSessionIds}
        onLaunchHandled={workspace.markLaunchHandled}
        onRuntimeObservation={workspace.updateRuntimeObservation}
      />
      <CommandPalette
        open={commandOpen}
        projects={projects}
        activeSession={activeSession}
        onClose={() => setCommandOpen(false)}
        onOpenSession={openAttentionSession}
        onOpenProject={selectProject}
        onDispatch={projectActions.dispatchToActiveSession}
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
      <ConfirmDialog
        open={paneToDetach !== null}
        title={t("workspace.detachConfirmTitle")}
        body={t("workspace.detachConfirmBody", {
          session: detachingSession ? text(detachingSession.title) : "",
        })}
        cancelLabel={t("workspace.detachConfirmCancel")}
        onCancel={cancelDetach}
        actions={[
          {
            label: t("workspace.detachConfirmAccept"),
            detail: t("workspace.detachConfirmAcceptDetail"),
            tone: "danger",
            onSelect: confirmDetach,
          },
        ]}
      />
      <ConfirmDialog
        open={closingPage !== null}
        title={t("pages.closeConfirmTitle")}
        body={
          closingImpact && closingImpact.runningCount > 0
            ? t("pages.closeConfirmRunning", {
                panes: closingImpact.paneCount,
                running: closingImpact.runningCount,
              })
            : t("pages.closeConfirmIdle", { panes: closingImpact?.paneCount ?? 0 })
        }
        cancelLabel={t("pages.closeConfirmCancel")}
        onCancel={cancelClose}
        actions={[
          {
            label: t("pages.closeConfirmAccept"),
            detail: t("pages.closeConfirmAcceptDetail"),
            tone: "danger",
            onSelect: confirmClose,
          },
        ]}
      />
      <ProjectDeleteDialog
        project={projectActions.deletingProject}
        onCancel={projectActions.cancelDeleteProject}
        onConfirm={projectActions.confirmDeleteProject}
      />
      <ConfirmDialog
        open={quitKills !== null}
        title={t("quit.title")}
        body={t("quit.body", { count: quitKills?.length ?? 0 })}
        cancelLabel={t("quit.cancel")}
        onCancel={() => setQuitKills(null)}
        actions={[
          {
            label: t("quit.killAll"),
            detail: t("quit.killAllDetail"),
            tone: "danger",
            onSelect: () => void invoke("app_quit", { kills: quitKills ?? [] }),
          },
          {
            label: t("quit.keep"),
            detail: t("quit.keepDetail"),
            tone: "primary",
            onSelect: () => void invoke("app_quit", { kills: [] }),
          },
        ]}
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
