import { useEffect, useRef, useState } from "react";
import type { DevSession, TerminalRuntimePhase } from "../domain";
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
  onLaunchHandled: (sessionId: string) => void;
  onPhaseChange: (sessionId: string, phase: TerminalRuntimePhase) => void;
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
  onLaunchHandled,
  onPhaseChange,
}: TerminalPaneProps) {
  const { statusLabel, t, text } = useI18n();
  const [runtimeAttached, setRuntimeAttached] = useState(false);
  const paneRef = useRef<HTMLElement | null>(null);
  const sessionTitle = text(session.title);
  const runtime = runtimeAttached
    ? session.launchProfile.label || t("terminal.localShell")
    : session.runtime.kind === "unconfigured"
      ? t("runtime.unconfigured")
      : text(runtimeLabel(session));

  useEffect(() => {
    if (!active || runtimeAttached || document.querySelector("dialog[open]")) return;
    const focused = document.activeElement as HTMLElement | null;
    if (
      focused &&
      (focused.tagName === "INPUT" || focused.tagName === "TEXTAREA" || focused.isContentEditable)
    ) {
      return;
    }
    paneRef.current?.focus({ preventScroll: true });
  }, [active, runtimeAttached]);

  return (
    <article
      ref={paneRef}
      className="terminal-pane"
      data-active={active}
      data-state={session.state}
      tabIndex={-1}
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
          <strong>{sessionTitle}</strong>
          <span className="terminal-pane__profile">{text(session.profile)}</span>
        </div>
        <div className="terminal-pane__actions">
          <span className="runtime-chip">{runtime}</span>
          <button
            type="button"
            aria-label={t("terminal.splitRight", { session: sessionTitle })}
            title={t("terminal.splitRight", { session: sessionTitle })}
            disabled={!canSplit}
            onClick={() => onSplit("horizontal")}
          >
            <Icon name="columns" size={15} />
          </button>
          <button
            type="button"
            aria-label={t("terminal.splitDown", { session: sessionTitle })}
            title={t("terminal.splitDown", { session: sessionTitle })}
            disabled={!canSplit}
            onClick={() => onSplit("vertical")}
          >
            <Icon name="rows" size={15} />
          </button>
          <button
            type="button"
            aria-label={t("terminal.movePage", { session: sessionTitle })}
            title={t("terminal.movePage", { session: sessionTitle })}
            disabled={!canMove}
            onClick={onMove}
          >
            <Icon name="move" size={15} />
          </button>
          <button
            type="button"
            aria-label={t("terminal.openConversation", { session: sessionTitle })}
            onClick={onOpenConversation}
          >
            <Icon name="conversation" size={16} />
          </button>
          <button
            type="button"
            aria-label={t("terminal.detach", { session: sessionTitle })}
            title={t("terminal.detach", { session: sessionTitle })}
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
        focused={active}
        onRuntimeAttached={setRuntimeAttached}
        onLaunchHandled={onLaunchHandled}
        onPhaseChange={onPhaseChange}
      />
    </article>
  );
}
