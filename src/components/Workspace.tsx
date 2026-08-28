import { useMemo } from "react";
import type { InspectorMode, Project, TerminalRuntimeObservation } from "../domain";
import { useI18n } from "../i18n";
import {
  type SplitDirection,
  type WorkspacePage,
  layoutForPaneLimit,
  listPanes,
} from "../layoutModel";
import type { DesktopPlatform } from "../platform";
import { shortcutDisplay, shortcutPairDisplay } from "../shortcutRegistry";
import { countSessions } from "../workspaceModel";
import { Icon } from "./Icon";
import { Inspector } from "./Inspector";
import { PageTabs } from "./PageTabs";
import { PaneLayoutView } from "./PaneLayoutView";
import { WorkspaceHeader } from "./WorkspaceHeader";

interface WorkspaceProps {
  project: Project;
  pages: readonly WorkspacePage[];
  activePageId: string;
  activePaneId: string | null;
  activeSessionId: string | null;
  platform: DesktopPlatform;
  inspectorMode: InspectorMode | null;
  inspectorPinned: boolean;
  maxPaneCount?: number;
  onSelectSession: (sessionId: string) => void;
  onSelectPane: (paneId: string, sessionId: string) => void;
  onSelectPage: (pageId: string) => void;
  onCreatePage: () => void;
  onClosePage: (pageId: string) => void;
  onMovePaneToPage: (paneId: string, pageId: string) => void;
  onMovePaneToNextPage: (paneId: string) => void;
  onAttachSession: (sessionId: string) => void;
  onCreateSessionInPage: () => void;
  onSplitPane: (paneId: string, direction: SplitDirection) => void;
  onDetachPane: (paneId: string) => void;
  onResizeSplit: (splitId: string, ratio: number) => void;
  onOpenInspector: (mode: InspectorMode) => void;
  onCloseInspector: () => void;
  onToggleInspectorPin: () => void;
  onLaunchHandled: (sessionId: string) => void;
  onRename: (sessionId: string, name: string) => void;
  onRuntimeObservation: (sessionId: string, observation: TerminalRuntimeObservation) => void;
}

export function Workspace({
  project,
  pages,
  activePageId,
  activePaneId,
  activeSessionId,
  platform,
  inspectorMode,
  inspectorPinned,
  maxPaneCount,
  onSelectSession,
  onSelectPane,
  onSelectPage,
  onCreatePage,
  onClosePage,
  onMovePaneToPage,
  onMovePaneToNextPage,
  onAttachSession,
  onCreateSessionInPage,
  onSplitPane,
  onDetachPane,
  onResizeSplit,
  onOpenInspector,
  onCloseInspector,
  onToggleInspectorPin,
  onLaunchHandled,
  onRename,
  onRuntimeObservation,
}: WorkspaceProps) {
  const { t } = useI18n();
  const counts = countSessions(project.sessions);
  const sessionsById = useMemo(
    () => new Map(project.sessions.map((session) => [session.id, session])),
    [project.sessions],
  );
  const activePage = pages.find((page) => page.id === activePageId) ?? pages[0];
  const activeSession =
    project.sessions.find((session) => session.id === activeSessionId) ??
    project.sessions.find((session) =>
      listPanes(activePage?.root ?? null).some((pane) => pane.sessionId === session.id),
    ) ??
    null;
  const waitingSession =
    project.sessions.find((session) => session.state === "needs-input") ?? null;
  const panes = listPanes(activePage?.root ?? null);
  const activePane = panes.find((pane) => pane.id === activePaneId) ?? panes[0] ?? null;
  const paneCount = panes.length;
  const displayRoot = maxPaneCount
    ? layoutForPaneLimit(activePage?.root ?? null, maxPaneCount, activeSession?.id ?? null)
    : (activePage?.root ?? null);
  const displayPaneCount = listPanes(displayRoot).length;
  const displayIsProjection = displayRoot !== (activePage?.root ?? null);

  return (
    <div className="workspace-screen" data-testid="workspace-screen">
      <WorkspaceHeader project={project} counts={counts} />

      {waitingSession ? (
        <button
          className="attention-strip"
          type="button"
          onClick={() => {
            onSelectSession(waitingSession.id);
            onOpenInspector("summary");
          }}
        >
          <span className="attention-strip__signal">!</span>
          <span className="attention-strip__copy">
            <small>{t("attention.eyebrow")}</small>
            <strong>{t("attention.title", { count: counts.needsInput })}</strong>
            <span>{t("attention.description")}</span>
          </span>
          <span className="attention-strip__action">
            {t("attention.open")}
            <Icon name="chevron" size={14} />
          </span>
        </button>
      ) : null}

      <section
        className="workspace-shell"
        aria-label={t("workspace.aria", { project: project.name })}
      >
        <div className="workspace-toolbar workspace-toolbar--pages">
          <PageTabs
            pages={pages}
            activePageId={activePageId}
            onSelectPage={onSelectPage}
            onCreatePage={onCreatePage}
            onClosePage={onClosePage}
            onMovePaneToPage={onMovePaneToPage}
            addShortcut={shortcutDisplay(platform, "newPage")}
            switchShortcut={shortcutPairDisplay(platform, "previousPage", "nextPage")}
            sessionsById={sessionsById}
          />
          <div className="workspace-toolbar__actions">
            <span className="pane-count">
              <span className="live-dot" />
              {t("workspace.paneCount", { count: paneCount })}
              {displayIsProjection ? (
                <strong>
                  {t("workspace.hiddenPanes", { count: paneCount - displayPaneCount })}
                </strong>
              ) : null}
            </span>
            <span className="toolbar-divider" />
            <button
              className="toolbar-button"
              type="button"
              data-testid="split-right"
              title={`${t("workspace.splitRight")} · ${shortcutDisplay(platform, "splitRight")}`}
              onClick={() => activePane && onSplitPane(activePane.id, "horizontal")}
              disabled={!activePane || paneCount >= (maxPaneCount ?? Number.POSITIVE_INFINITY)}
            >
              <Icon name="columns" size={16} />
              <span>{t("workspace.splitRight")}</span>
              <kbd>{shortcutDisplay(platform, "splitRight")}</kbd>
            </button>
            <button
              className="toolbar-button"
              type="button"
              data-testid="split-down"
              title={`${t("workspace.splitDown")} · ${shortcutDisplay(platform, "splitDown")}`}
              onClick={() => activePane && onSplitPane(activePane.id, "vertical")}
              disabled={!activePane || paneCount >= (maxPaneCount ?? Number.POSITIVE_INFINITY)}
            >
              <Icon name="rows" size={16} />
              <span>{t("workspace.splitDown")}</span>
              <kbd>{shortcutDisplay(platform, "splitDown")}</kbd>
            </button>
            <button
              className="toolbar-button"
              type="button"
              title={`${t("workspace.closePane")} · ${shortcutDisplay(platform, "closePane")}`}
              onClick={() => activePane && onDetachPane(activePane.id)}
              disabled={!activePane}
            >
              <Icon name="x" size={15} />
              <span>{t("workspace.closePane")}</span>
              <kbd>{shortcutDisplay(platform, "closePane")}</kbd>
            </button>
            <span className="toolbar-divider" />
            <button
              className="toolbar-button"
              type="button"
              title={`${t("workspace.summary")} · ${shortcutDisplay(platform, "summary")}`}
              data-active={inspectorMode === "summary"}
              onClick={() =>
                inspectorMode === "summary" ? onCloseInspector() : onOpenInspector("summary")
              }
              disabled={!activeSession}
            >
              <Icon name="summary" size={16} />
              <span>{t("workspace.summary")}</span>
              <kbd>{shortcutDisplay(platform, "summary")}</kbd>
            </button>
            <button
              className="toolbar-button"
              type="button"
              title={`${t("workspace.terminalLog")} · ${shortcutDisplay(platform, "terminalLog")}`}
              data-active={inspectorMode === "terminal"}
              onClick={() =>
                inspectorMode === "terminal" ? onCloseInspector() : onOpenInspector("terminal")
              }
              disabled={!activeSession}
            >
              <Icon name="terminal" size={16} />
              <span>{t("workspace.terminalLog")}</span>
              <kbd>{shortcutDisplay(platform, "terminalLog")}</kbd>
            </button>
          </div>
        </div>

        <div
          className="workspace-shell__body"
          data-inspector-open={Boolean(inspectorMode)}
          data-inspector-pinned={Boolean(inspectorMode && inspectorPinned)}
        >
          <div className="pane-stage">
            <PaneLayoutView
              node={displayRoot}
              sessions={project.sessions}
              projectPath={project.path}
              activePaneId={activePane?.id ?? null}
              canMovePane={pages.length > 1}
              canSplitPane={paneCount < (maxPaneCount ?? Number.POSITIVE_INFINITY)}
              canResizeSplits={!displayIsProjection}
              onAttachSession={onAttachSession}
              onCreateSession={onCreateSessionInPage}
              onSelectPane={onSelectPane}
              onOpenConversation={(sessionId) => {
                const pane = panes.find((candidate) => candidate.sessionId === sessionId);
                if (pane) onSelectPane(pane.id, sessionId);
                onOpenInspector("conversation");
              }}
              onSplitPane={onSplitPane}
              onMovePane={onMovePaneToNextPage}
              onDetachPane={onDetachPane}
              onResizeSplit={onResizeSplit}
              onLaunchHandled={onLaunchHandled}
              onRename={onRename}
              onRuntimeObservation={onRuntimeObservation}
            />
          </div>

          {activeSession && inspectorMode ? (
            <Inspector
              session={activeSession}
              mode={inspectorMode}
              pinned={inspectorPinned}
              onChangeMode={onOpenInspector}
              onTogglePin={onToggleInspectorPin}
              onClose={onCloseInspector}
            />
          ) : null}
        </div>

        <footer className="workspace-statusbar">
          <span>
            <Icon name="branch" size={13} />
            {project.branch}
          </span>
          <span className="workspace-statusbar__spacer" />
          <span>{t("workspace.localFirst")}</span>
          <span className="statusbar-dot" />
          <span>{t("workspace.runtimePending")}</span>
        </footer>
      </section>
    </div>
  );
}
