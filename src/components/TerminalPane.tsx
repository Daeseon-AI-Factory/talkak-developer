import { useState } from "react";
import type { DevSession } from "../domain";
import { useI18n } from "../i18n";
import type { SplitDirection } from "../layoutModel";
import { runtimeLabel } from "../workspaceModel";
import { Icon } from "./Icon";
import { writePaneDragData } from "./PageTabs";
import { SessionTerminal } from "./SessionTerminal";

interface TerminalPaneProps {
  paneId: string;
  session: DevSession;
  projectPath: string;
  active: boolean;
  canMove: boolean;
  canSplit: boolean;
  onFocus: () => void;
  onOpenConversation: () => void;
  onSplit: (direction: SplitDirection) => void;
  onMove: () => void;
  onDetach: () => void;
}

export function TerminalPane({
  paneId,
  session,
  projectPath,
  active,
  canMove,
  canSplit,
  onFocus,
  onOpenConversation,
  onSplit,
  onMove,
  onDetach,
}: TerminalPaneProps) {
  const { statusLabel, t } = useI18n();
  const [runtimeAttached, setRuntimeAttached] = useState(false);
  const runtime = runtimeAttached
    ? session.launchProfile.label || t("terminal.localShell")
    : session.runtime.kind === "unconfigured"
      ? t("runtime.unconfigured")
      : runtimeLabel(session);
  return (
    <article
      className="terminal-pane"
      data-active={active}
      data-state={session.state}
      onMouseDown={onFocus}
    >
      <header
        className="terminal-pane__header"
        draggable
        onDragStart={(event) => writePaneDragData(event, paneId)}
        title={t("terminal.dragPane")}
      >
        <div className="terminal-pane__title">
          <span className="terminal-pane__status" />
          <Icon name="terminal" size={16} />
          <strong>{session.title}</strong>
          <span className="terminal-pane__profile">{session.profile}</span>
        </div>
        <div className="terminal-pane__actions">
          <span className="runtime-chip">{runtime}</span>
          <button
            type="button"
            aria-label={t("terminal.splitRight", { session: session.title })}
            title={t("terminal.splitRight", { session: session.title })}
            disabled={!canSplit}
            onClick={() => onSplit("horizontal")}
          >
            <Icon name="columns" size={15} />
          </button>
          <button
            type="button"
            aria-label={t("terminal.splitDown", { session: session.title })}
            title={t("terminal.splitDown", { session: session.title })}
            disabled={!canSplit}
            onClick={() => onSplit("vertical")}
          >
            <Icon name="rows" size={15} />
          </button>
          <button
            type="button"
            aria-label={t("terminal.movePage", { session: session.title })}
            title={t("terminal.movePage", { session: session.title })}
            disabled={!canMove}
            onClick={onMove}
          >
            <Icon name="move" size={15} />
          </button>
          <button
            type="button"
            aria-label={t("terminal.openConversation", { session: session.title })}
            onClick={onOpenConversation}
          >
            <Icon name="conversation" size={16} />
          </button>
          <button
            type="button"
            aria-label={t("terminal.detach", { session: session.title })}
            title={t("terminal.detach", { session: session.title })}
            onClick={onDetach}
          >
            <Icon name="x" size={15} />
          </button>
        </div>
      </header>

      <div className="terminal-pane__meta">
        <span>{session.branch}</span>
        <span>·</span>
        <span>{session.runtime.shell}</span>
        <span className="terminal-pane__meta-spacer" />
        <span data-state={session.state}>{statusLabel(session.state)}</span>
      </div>

      <SessionTerminal
        session={session}
        projectPath={projectPath}
        onRuntimeAttached={setRuntimeAttached}
      />
    </article>
  );
}
