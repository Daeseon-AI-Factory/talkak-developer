import type { CSSProperties, PointerEvent } from "react";
import type { DevSession } from "../domain";
import { useI18n } from "../i18n";
import type { LayoutNode, SplitDirection, SplitNode } from "../layoutModel";
import { Icon } from "./Icon";
import { TerminalPane } from "./TerminalPane";

interface PaneLayoutViewProps {
  node: LayoutNode | null;
  sessions: readonly DevSession[];
  projectPath: string;
  activeSessionId: string | null;
  canMovePane: boolean;
  canSplitPane: boolean;
  canResizeSplits: boolean;
  onAttachSession: (sessionId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onOpenConversation: (sessionId: string) => void;
  onSplitPane: (paneId: string, direction: SplitDirection) => void;
  onMovePane: (paneId: string) => void;
  onDetachPane: (paneId: string) => void;
  onResizeSplit: (splitId: string, ratio: number) => void;
}

export function PaneLayoutView(props: PaneLayoutViewProps) {
  if (props.node === null) {
    return <EmptyPage sessions={props.sessions} onAttachSession={props.onAttachSession} />;
  }

  if (props.node.kind === "pane") {
    const pane = props.node;
    const session = props.sessions.find((candidate) => candidate.id === pane.sessionId);
    if (!session) return <MissingSession sessionId={pane.sessionId} />;

    return (
      <TerminalPane
        paneId={pane.id}
        session={session}
        projectPath={props.projectPath}
        active={session.id === props.activeSessionId}
        canMove={props.canMovePane}
        canSplit={props.canSplitPane}
        onFocus={() => props.onSelectSession(session.id)}
        onOpenConversation={() => props.onOpenConversation(session.id)}
        onSplit={(direction) => props.onSplitPane(pane.id, direction)}
        onMove={() => props.onMovePane(pane.id)}
        onDetach={() => props.onDetachPane(pane.id)}
      />
    );
  }

  return <SplitLayout node={props.node} props={props} />;
}

function SplitLayout({ node, props }: { node: SplitNode; props: PaneLayoutViewProps }) {
  const { t } = useI18n();
  const firstStyle = {
    "--pane-ratio": `${node.ratio * 100}%`,
  } as CSSProperties;

  function resize(event: PointerEvent<HTMLButtonElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const container = event.currentTarget.parentElement;
    if (!container) return;
    const bounds = container.getBoundingClientRect();
    const rawRatio =
      node.direction === "horizontal"
        ? (event.clientX - bounds.left) / bounds.width
        : (event.clientY - bounds.top) / bounds.height;
    const ratio = Math.min(0.8, Math.max(0.2, rawRatio));
    props.onResizeSplit(node.id, Math.round(ratio * 1000) / 1000);
  }

  return (
    <div className="split-layout" data-direction={node.direction}>
      <div className="split-layout__first" style={firstStyle}>
        <PaneLayoutView {...props} node={node.first} />
      </div>
      <button
        className="split-layout__divider"
        type="button"
        disabled={!props.canResizeSplits}
        aria-label={
          node.direction === "horizontal"
            ? t("workspace.resizeHorizontal")
            : t("workspace.resizeVertical")
        }
        onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
        onPointerMove={resize}
        onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
      >
        <span />
      </button>
      <div className="split-layout__second">
        <PaneLayoutView {...props} node={node.second} />
      </div>
    </div>
  );
}

function EmptyPage({
  sessions,
  onAttachSession,
}: {
  sessions: readonly DevSession[];
  onAttachSession: (sessionId: string) => void;
}) {
  const { statusLabel, t } = useI18n();
  return (
    <div className="empty-page">
      <span className="empty-page__icon">
        <Icon name="terminal" size={24} />
      </span>
      <div>
        <h2>{t("pages.emptyTitle")}</h2>
        <p>{t("pages.emptyDescription")}</p>
      </div>
      <div className="empty-page__sessions">
        {sessions.map((session) => (
          <button type="button" key={session.id} onClick={() => onAttachSession(session.id)}>
            <span className="terminal-pane__status" data-state={session.state} />
            <strong>{session.title}</strong>
            <small>{statusLabel(session.state)}</small>
          </button>
        ))}
      </div>
    </div>
  );
}

function MissingSession({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  return (
    <div className="empty-page">
      <span className="empty-page__icon">!</span>
      <div>
        <h2>{t("pages.missingSession")}</h2>
        <code>{sessionId}</code>
      </div>
    </div>
  );
}
