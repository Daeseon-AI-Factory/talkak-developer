import { useEffect, useRef, useState } from "react";
import type { DevSession, TerminalRuntimeObservation } from "../domain";
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
  onRename: (sessionId: string, name: string) => void;
  onRuntimeObservation: (sessionId: string, observation: TerminalRuntimeObservation) => void;
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
  onRename,
  onRuntimeObservation,
}: TerminalPaneProps) {
  const { runtimePhaseLabel, statusLabel, t, text } = useI18n();
  const [runtimeAttached, setRuntimeAttached] = useState(false);
  const [renaming, setRenaming] = useState(false);
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
      data-runtime-phase={session.runtimeStatus?.phase}
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
          {renaming ? (
            <input
              className="terminal-pane__rename"
              // Editing a name must not drag the pane out from under the cursor.
              draggable={false}
              onDragStart={(event) => event.stopPropagation()}
              defaultValue={typeof session.title === "string" ? session.title : ""}
              placeholder={t("terminal.renamePlaceholder")}
              aria-label={t("terminal.rename")}
              // biome-ignore lint/a11y/noAutofocus: opening the field is the request to type in it
              autoFocus
              onBlur={(event) => {
                onRename(session.id, event.currentTarget.value);
                setRenaming(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  // Escape abandons the edit; blur would otherwise commit it.
                  event.currentTarget.value =
                    typeof session.title === "string" ? session.title : "";
                  setRenaming(false);
                }
                event.stopPropagation();
              }}
            />
          ) : (
            <button
              className="terminal-pane__rename-trigger"
              type="button"
              title={t("terminal.rename")}
              onClick={() => setRenaming(true)}
            >
              <strong>{sessionTitle}</strong>
            </button>
          )}
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
        <span data-state={session.state} data-runtime-phase={session.runtimeStatus?.phase}>
          {session.runtimeStatus
            ? runtimePhaseLabel(session.runtimeStatus.phase, session.runtimeStatus.exitCode)
            : statusLabel(session.state)}
        </span>
      </div>

      <SessionTerminal
        session={session}
        projectPath={projectPath}
        focused={active}
        onRuntimeAttached={setRuntimeAttached}
        onLaunchHandled={onLaunchHandled}
        onRuntimeObservation={onRuntimeObservation}
      />
    </article>
  );
}
