import type { InspectorMode, Project } from "../domain";
import { useI18n } from "../i18n";
import {
  type SplitDirection,
  type WorkspacePage,
  layoutForPaneLimit,
  listPanes,
} from "../layoutModel";
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
  activeSessionId: string | null;
  inspectorMode: InspectorMode | null;
  inspectorPinned: boolean;
  maxPaneCount?: number;
  onSelectSession: (sessionId: string) => void;
  onSelectPage: (pageId: string) => void;
  onCreatePage: () => void;
  onClosePage: (pageId: string) => void;
  onMovePaneToPage: (paneId: string, pageId: string) => void;
  onMovePaneToNextPage: (paneId: string) => void;
  onAttachSession: (sessionId: string) => void;
  onSplitPane: (paneId: string, direction: SplitDirection) => void;
  onDetachPane: (paneId: string) => void;
  onResizeSplit: (splitId: string, ratio: number) => void;
  onOpenInspector: (mode: InspectorMode) => void;
  onCloseInspector: () => void;
  onToggleInspectorPin: () => void;
  onCreateSession: () => void;
}

export function Workspace({
  project,
  pages,
  activePageId,
  activeSessionId,
  inspectorMode,
  inspectorPinned,
  maxPaneCount,
  onSelectSession,
  onSelectPage,
  onCreatePage,
  onClosePage,
  onMovePaneToPage,
  onMovePaneToNextPage,
  onAttachSession,
  onSplitPane,
  onDetachPane,
  onResizeSplit,
  onOpenInspector,
  onCloseInspector,
  onToggleInspectorPin,
  onCreateSession,
}: WorkspaceProps) {
  const { t } = useI18n();
  const counts = countSessions(project.sessions);
  const activePage = pages.find((page) => page.id === activePageId) ?? pages[0];
  const activeSession =
    project.sessions.find((session) => session.id === activeSessionId) ??
    project.sessions.find((session) =>
      listPanes(activePage?.root ?? null).some((pane) => pane.sessionId === session.id),
    ) ??
    null;
  const waitingSession =
    project.sessions.find((session) => session.state === "needs-input") ?? null;
  const paneCount = listPanes(activePage?.root ?? null).length;
  const displayRoot = maxPaneCount
    ? layoutForPaneLimit(activePage?.root ?? null, maxPaneCount, activeSession?.id ?? null)
    : (activePage?.root ?? null);
  const displayPaneCount = listPanes(displayRoot).length;
  const displayIsProjection = displayRoot !== (activePage?.root ?? null);

  return (
    <div className="workspace-screen">
      <WorkspaceHeader project={project} counts={counts} onCreateSession={onCreateSession} />

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
          />
          <div className="workspace-toolbar__actions">
            <span className="pane-count">
              <span className="live-dot" />
              {t("workspace.paneCount", { count: displayPaneCount })}
            </span>
            <span className="toolbar-divider" />
            <button
              className="toolbar-button"
              type="button"
              data-active={inspectorMode === "summary"}
              onClick={() => onOpenInspector("summary")}
              disabled={!activeSession}
            >
              <Icon name="summary" size={16} />
              {t("workspace.summary")}
            </button>
            <button
              className="toolbar-button"
              type="button"
              data-active={inspectorMode === "conversation"}
              onClick={() => onOpenInspector("conversation")}
              disabled={!activeSession}
            >
              <Icon name="conversation" size={16} />
              {t("workspace.conversation")}
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
              activeSessionId={activeSession?.id ?? null}
              canMovePane={pages.length > 1}
              canSplitPane={paneCount < (maxPaneCount ?? Number.POSITIVE_INFINITY)}
              canResizeSplits={!displayIsProjection}
              onAttachSession={onAttachSession}
              onSelectSession={onSelectSession}
              onOpenConversation={(sessionId) => {
                onSelectSession(sessionId);
                onOpenInspector("conversation");
              }}
              onSplitPane={onSplitPane}
              onMovePane={onMovePaneToNextPage}
              onDetachPane={onDetachPane}
              onResizeSplit={onResizeSplit}
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
