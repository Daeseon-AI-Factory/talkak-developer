import type { DevSession, InspectorMode } from "../domain";
import { useI18n } from "../i18n";
import { runtimeLabel } from "../workspaceModel";
import { Icon } from "./Icon";
import { TerminalLogView } from "./TerminalLogView";

interface InspectorProps {
  session: DevSession;
  mode: InspectorMode;
  pinned: boolean;
  onChangeMode: (mode: InspectorMode) => void;
  onTogglePin: () => void;
  onClose: () => void;
}

export function Inspector({
  session,
  mode,
  pinned,
  onChangeMode,
  onTogglePin,
  onClose,
}: InspectorProps) {
  const { t, text } = useI18n();
  return (
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

      {mode === "summary" ? <SummaryView session={session} /> : null}
      {mode === "terminal" ? <TerminalLogView sessionId={session.id} /> : null}
      {mode === "conversation" ? <ConversationView session={session} /> : null}
    </aside>
  );
}

function SummaryView({ session }: { session: DevSession }) {
  const { runtimePhaseLabel, statusLabel, t, text } = useI18n();
  const runtime =
    session.runtime.kind === "unconfigured"
      ? t("runtime.unconfigured")
      : text(runtimeLabel(session));
  return (
    <div className="inspector__content">
      <section className="summary-hero">
        <div className="summary-hero__source">{t("inspector.localPreview")}</div>
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
        {session.summary.changedFiles.map((file) => (
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

function ConversationView({ session }: { session: DevSession }) {
  const { t } = useI18n();
  return (
    <div className="inspector__content conversation-list">
      <div className="conversation-list__meta">
        <span>{t("inspector.messageCount", { count: session.conversation.length })}</span>
        <span>{t("inspector.localPreview")}</span>
      </div>
      {session.conversation.map((entry) => (
        <article className="conversation-entry" data-author={entry.author} key={entry.id}>
          <header>
            <strong>
              {entry.author === "you"
                ? t("inspector.you")
                : entry.author === "agent"
                  ? t("inspector.agent")
                  : t("inspector.system")}
            </strong>
            <time>{entry.time}</time>
          </header>
          <p>{entry.text}</p>
        </article>
      ))}
      <div className="conversation-disclaimer">{t("inspector.transcriptHelp")}</div>
    </div>
  );
}
