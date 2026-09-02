import { useEffect } from "react";
import type { DevSession, InspectorMode, ProjectSource } from "../domain";
import { useI18n } from "../i18n";
import type { TranscriptUsage } from "../runtime/transcriptClient";
import {
  formatTokenCount,
  formatTranscriptActivity,
  latestAssistantExcerpt,
} from "../runtime/transcriptPresentation";
import { type TranscriptState, useAgentTranscript } from "../runtime/useAgentTranscript";
import { runtimeLabel } from "../workspaceModel";
import { ConversationView, TranscriptNotice } from "./ConversationView";
import { Icon } from "./Icon";
import { TerminalLogView } from "./TerminalLogView";

interface InspectorProps {
  session: DevSession;
  projectPath: string;
  projectSource: ProjectSource;
  mode: InspectorMode;
  pinned: boolean;
  onChangeMode: (mode: InspectorMode) => void;
  onTogglePin: () => void;
  onClose: () => void;
}

export function Inspector({
  session,
  projectPath,
  projectSource,
  mode,
  pinned,
  onChangeMode,
  onTogglePin,
  onClose,
}: InspectorProps) {
  const { t, text } = useI18n();
  const preview = projectSource === "preview";
  const { state: transcriptState } = useAgentTranscript(
    preview
      ? null
      : {
          sessionId: session.id,
          runId: session.runtimeStatus?.runId ?? null,
          projectPath,
          startedAt: session.startedAt,
          agentCommand: session.launchProfile.command,
        },
    !preview && mode !== "terminal",
    session.runtimeStatus?.phase ?? null,
  );

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

      {mode === "summary" ? (
        <SummaryView session={session} state={transcriptState} preview={preview} />
      ) : null}
      {mode === "terminal" ? (
        <TerminalLogView
          sessionId={session.id}
          currentRunId={session.runtimeStatus?.runId ?? null}
        />
      ) : null}
      {mode === "conversation" ? (
        <ConversationView
          key={`${projectPath}:${session.id}:${session.runtimeStatus?.runId ?? "no-run"}`}
          session={session}
          state={transcriptState}
          preview={preview}
          className="inspector__content conversation-list"
          showMeta
        />
      ) : null}
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

function SummaryView({
  session,
  state,
  preview,
}: {
  session: DevSession;
  state: TranscriptState;
  preview: boolean;
}) {
  if (preview) return <PreviewSummary session={session} />;
  return <LocalTranscriptSummary session={session} state={state} />;
}

function PreviewSummary({ session }: { session: DevSession }) {
  const { runtimePhaseLabel, statusLabel, t, text } = useI18n();
  const runtime =
    session.runtime.kind === "unconfigured"
      ? t("runtime.unconfigured")
      : text(runtimeLabel(session));

  return (
    <div className="inspector__content">
      <section className="summary-hero">
        <div className="summary-hero__source">{t("inspector.previewData")}</div>
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

      <ChangedFiles files={session.summary.changedFiles} />

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

function LocalTranscriptSummary({
  session,
  state,
}: { session: DevSession; state: TranscriptState }) {
  const { runtimePhaseLabel, statusLabel, t, text } = useI18n();
  const runtime =
    session.runtime.kind === "unconfigured"
      ? t("runtime.unconfigured")
      : text(runtimeLabel(session));
  const transcript = state.kind === "loaded" ? state.transcript : null;
  const latestReply = transcript ? latestAssistantExcerpt(transcript.entries) : null;
  const lastActivity = formatTranscriptActivity(transcript?.lastActivity ?? null);

  return (
    <div className="inspector__content">
      <section className="summary-hero">
        <div className="summary-hero__source">
          {transcript
            ? t("transcript.source", { source: transcript.source })
            : t("inspector.localRecord")}
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
        {transcript ? (
          <>
            <span className="summary-hero__label">{t("inspector.latestReply")}</span>
            {latestReply ? (
              <h2>{latestReply}</h2>
            ) : (
              <p className="summary-section__empty">{t("inspector.noAssistantReply")}</p>
            )}
          </>
        ) : (
          <TranscriptNotice state={state} />
        )}
      </section>

      {transcript ? (
        <>
          <SummarySection title={t("inspector.lastActivity")} empty={t("inspector.noActivity")}>
            {lastActivity ? <p className="summary-activity">{lastActivity}</p> : null}
          </SummarySection>
          <UsageSection usage={transcript.usage} />
          <ChangedFiles files={transcript.changedFiles} />
        </>
      ) : null}
    </div>
  );
}

/** Token counts the agent's own record carries — a size, not a bill. Absent counts say so. */
function UsageSection({ usage }: { usage: TranscriptUsage | null }) {
  const { t } = useI18n();
  return (
    <SummarySection title={t("inspector.usage")} empty={t("inspector.noUsage")}>
      {usage ? (
        <div className="usage-grid">
          <UsageRow label={t("inspector.usageOutput")} value={usage.outputTokens} />
          <UsageRow label={t("inspector.usageInput")} value={usage.inputTokens} />
          <UsageRow label={t("inspector.usageCacheRead")} value={usage.cacheReadTokens} />
          <UsageRow label={t("inspector.usageCacheCreation")} value={usage.cacheCreationTokens} />
          <small className="usage-grid__note">
            {t("inspector.usageMessages", { count: usage.messages })}
          </small>
        </div>
      ) : null}
    </SummarySection>
  );
}

function UsageRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="usage-row">
      <span>{label}</span>
      <strong title={value.toLocaleString()}>{formatTokenCount(value)}</strong>
    </div>
  );
}

function ChangedFiles({ files }: { files: readonly string[] }) {
  const { t } = useI18n();
  return (
    <SummarySection title={t("inspector.changedFiles")} empty={t("inspector.noFiles")}>
      {files.map((file) => (
        <div className="file-row" key={file}>
          <Icon name="folder" size={14} />
          <code>{file}</code>
        </div>
      ))}
    </SummarySection>
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
