import { useEffect } from "react";
import type { DevSession, InspectorMode } from "../domain";
import { useI18n } from "../i18n";
import { type TranscriptState, useAgentTranscript } from "../runtime/useAgentTranscript";
import { runtimeLabel } from "../workspaceModel";
import { Icon } from "./Icon";
import { TerminalLogView } from "./TerminalLogView";

interface InspectorProps {
  session: DevSession;
  /** The project directory, which is how an agent transcript on disk is found. */
  projectPath: string;
  mode: InspectorMode;
  pinned: boolean;
  onChangeMode: (mode: InspectorMode) => void;
  onTogglePin: () => void;
  onClose: () => void;
}

export function Inspector({
  session,
  projectPath,
  mode,
  pinned,
  onChangeMode,
  onTogglePin,
  onClose,
}: InspectorProps) {
  const { t, text } = useI18n();

  // The floating form is a modal, so it closes the way every modal here closes. A window listener
  // rather than onKeyDown on the panel: focus usually sits inside xterm, not on the dialog.
  useEffect(() => {
    if (pinned) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [pinned, onClose]);

  const panel = (
    <aside className="inspector" data-pinned={pinned} aria-label={t("inspector.aria")}>
      <header className="inspector__header">
        <div>
          <span className="inspector__eyebrow">{t("inspector.title")}</span>
          <strong>{text(session.title)}</strong>
        </div>
        <div className="inspector__header-actions">
          <button
            type="button"
            data-active={pinned}
            aria-pressed={pinned}
            aria-label={pinned ? t("inspector.unpin") : t("inspector.pin")}
            title={pinned ? t("inspector.unpin") : t("inspector.pin")}
            onClick={onTogglePin}
          >
            <Icon name="pin" size={15} />
          </button>
          <button type="button" aria-label={t("inspector.close")} onClick={onClose}>
            <Icon name="x" size={17} />
          </button>
        </div>
      </header>

      <div className="inspector-tabs" role="tablist" aria-label={t("inspector.tabsAria")}>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "terminal"}
          data-active={mode === "terminal"}
          onClick={() => onChangeMode("terminal")}
        >
          <Icon name="terminal" size={15} />
          {t("inspector.terminal")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "summary"}
          data-active={mode === "summary"}
          onClick={() => onChangeMode("summary")}
        >
          <Icon name="summary" size={15} />
          {t("inspector.summary")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "conversation"}
          data-active={mode === "conversation"}
          onClick={() => onChangeMode("conversation")}
        >
          <Icon name="conversation" size={15} />
          {t("inspector.conversation")}
        </button>
      </div>

      {mode === "summary" ? <SummaryView session={session} projectPath={projectPath} /> : null}
      {mode === "terminal" ? <TerminalLogView sessionId={session.id} /> : null}
      {mode === "conversation" ? <ConversationView projectPath={projectPath} /> : null}
    </aside>
  );

  if (pinned) return panel;
  return (
    <div
      className="inspector-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {panel}
    </div>
  );
}

function SummaryView({ session, projectPath }: { session: DevSession; projectPath: string }) {
  const { runtimePhaseLabel, statusLabel, t, text } = useI18n();
  const { state } = useAgentTranscript(projectPath, true);
  const runtime =
    session.runtime.kind === "unconfigured"
      ? t("runtime.unconfigured")
      : text(runtimeLabel(session));
  // The agent's own record names the files it edited. `session.summary.changedFiles` is seeded
  // demo content that nothing has ever written to for a real session.
  const changedFiles = state.kind === "loaded" ? state.transcript.changedFiles : [];
  return (
    <div className="inspector__content">
      <section className="summary-hero">
        <div className="summary-hero__source">
          {state.kind === "loaded"
            ? t("transcript.source", { source: state.transcript.source })
            : t("inspector.localPreview")}
        </div>
        <div className="summary-hero__status-row">
          <span
            className="state-badge"
            data-state={session.state}
            data-runtime-phase={session.runtimeStatus?.phase}
          >
            {session.runtimeStatus
              ? runtimePhaseLabel(session.runtimeStatus.phase, session.runtimeStatus.exitCode)
              : statusLabel(session.state)}
          </span>
          <span>{runtime}</span>
        </div>
        <h2>{text(session.summary.outcome)}</h2>
        <div
          className="progress-track"
          aria-label={t("inspector.progress", { progress: session.summary.progress })}
        >
          <span style={{ width: `${session.summary.progress}%` }} />
        </div>
        <small>{t("inspector.progressShort", { progress: session.summary.progress })}</small>
      </section>

      <SummarySection title={t("inspector.changedFiles")} empty={t("inspector.noFiles")}>
        {changedFiles.map((file) => (
          <div className="file-row" key={file}>
            <Icon name="folder" size={14} />
            <code>{file}</code>
          </div>
        ))}
      </SummarySection>

      <SummarySection title={t("inspector.decisions")} empty={t("inspector.noDecisions")}>
        {session.summary.decisions.map((decision) => (
          <div className="decision-row" key={decision}>
            <span>✓</span>
            <p>{decision}</p>
          </div>
        ))}
      </SummarySection>

      <section className="next-step-card">
        <span>{t("inspector.nextStep")}</span>
        <p>{text(session.summary.nextStep)}</p>
      </section>
    </div>
  );
}

interface SummarySectionProps {
  title: string;
  empty: string;
  children: React.ReactNode;
}

function SummarySection({ title, empty, children }: SummarySectionProps) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <section className="summary-section">
      <h3>{title}</h3>
      {hasChildren ? children : <p className="summary-section__empty">{empty}</p>}
    </section>
  );
}

/** Says why there is nothing to show, which is never the same as showing nothing. */
function TranscriptNotice({ state }: { state: TranscriptState }) {
  const { t } = useI18n();
  if (state.kind === "loading")
    return <p className="conversation-disclaimer">{t("transcript.loading")}</p>;
  if (state.kind === "unsupported")
    return <p className="conversation-disclaimer">{t("transcript.unsupported")}</p>;
  if (state.kind === "absent")
    return <p className="conversation-disclaimer">{t("transcript.absent")}</p>;
  if (state.kind === "failed")
    return (
      <output className="conversation-disclaimer" data-tone="danger">
        {t("transcript.failed", { message: state.message })}
      </output>
    );
  return null;
}

function ConversationView({ projectPath }: { projectPath: string }) {
  const { t } = useI18n();
  const { state } = useAgentTranscript(projectPath, true);

  if (state.kind !== "loaded") {
    return (
      <div className="inspector__content conversation-list">
        <TranscriptNotice state={state} />
      </div>
    );
  }

  const { transcript } = state;
  const dropped = transcript.totalEntries - transcript.entries.length;
  return (
    <div className="inspector__content conversation-list">
      <div className="conversation-list__meta">
        <span>{t("inspector.messageCount", { count: transcript.totalEntries })}</span>
        <span>{t("transcript.source", { source: transcript.source })}</span>
      </div>
      {dropped > 0 ? (
        <p className="conversation-disclaimer">{t("transcript.trimmed", { count: dropped })}</p>
      ) : null}
      {transcript.entries.map((entry, index) => (
        <article
          className="conversation-entry"
          data-author={entry.role === "user" ? "you" : "agent"}
          // The record has no per-turn id; position plus timestamp is stable for a given read.
          key={`${entry.at ?? "no-time"}-${index}`}
        >
          <header>
            <strong>{entry.role === "user" ? t("inspector.you") : t("inspector.agent")}</strong>
            <time>{formatTurnTime(entry.at)}</time>
          </header>
          <p>{entry.text}</p>
        </article>
      ))}
    </div>
  );
}

/** The record stores ISO instants; a reader wants a clock time. */
function formatTurnTime(at: string | null): string {
  if (!at) return "";
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime())
    ? ""
    : parsed.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
