import { type CSSProperties, type RefObject, useRef, useState } from "react";
import { useConversationScroll } from "../conversationScroll";
import type { DevSession, Project } from "../domain";
import { useI18n } from "../i18n";
import {
  INITIAL_TRANSCRIPT_TURNS,
  OLDER_TRANSCRIPT_PAGE,
  formatTranscriptActivity,
  formatTranscriptTime,
  latestAssistantExcerpt,
} from "../runtime/transcriptPresentation";
import { type TranscriptState, useAgentTranscript } from "../runtime/useAgentTranscript";
import { TerminalLogView } from "./TerminalLogView";

export type MobileSessionTab = "conversation" | "terminal" | "summary";

interface MobileSessionViewProps {
  project: Project;
  session: DevSession | null;
  draft: string;
  activeTab: MobileSessionTab;
  reviewedDraft: string | null;
  voiceEnabled: boolean;
  onDraftChange: (value: string) => void;
  onSelectSession: (sessionId: string) => void;
  onSelectTab: (tab: MobileSessionTab) => void;
  onReviewDraft: () => void;
  onEditDraft: () => void;
  onOpenSettings: () => void;
}

const touchTarget: CSSProperties = {
  minWidth: 44,
  minHeight: 44,
};

const quickReplyKeys = [
  "mobile.quickContinue",
  "mobile.quickExplain",
  "mobile.quickReview",
] as const;

export function MobileSessionView({
  project,
  session,
  draft,
  activeTab,
  reviewedDraft,
  voiceEnabled,
  onDraftChange,
  onSelectSession,
  onSelectTab,
  onReviewDraft,
  onEditDraft,
  onOpenSettings,
}: MobileSessionViewProps) {
  const { runtimePhaseLabel, statusLabel, t, text } = useI18n();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const visibleReview = reviewedDraft === draft ? reviewedDraft : null;
  const preview = project.source === "preview";
  const { state: transcriptState } = useAgentTranscript(
    !preview && session
      ? {
          sessionId: session.id,
          runId: session.runtimeStatus?.runId ?? null,
          projectPath: project.path,
          startedAt: session.startedAt,
          agentCommand: session.launchProfile.command,
        }
      : null,
    !preview && Boolean(session) && activeTab !== "terminal",
    session?.runtimeStatus?.phase ?? null,
  );

  function updateDraft(value: string) {
    onDraftChange(value);
  }

  function useQuickReply(value: string) {
    const current = draft.trim();
    updateDraft(current ? `${current}\n${value}` : value);
  }

  function openDraftReview() {
    if (!session || !draft.trim()) return;
    onReviewDraft();
  }

  return (
    <section className="mobile-session-view" aria-label={t("mobile.session")}>
      <header className="mobile-session-view__header">
        <div>
          <span className="mobile-session-view__project">{project.name}</span>
          <h1>{session ? text(session.title) : t("mobile.noSession")}</h1>
        </div>
        {session ? (
          <span
            className="state-badge"
            data-state={session.state}
            data-runtime-phase={session.runtimeStatus?.phase}
          >
            {session.runtimeStatus
              ? runtimePhaseLabel(session.runtimeStatus.phase, session.runtimeStatus.exitCode)
              : statusLabel(session.state)}
          </span>
        ) : null}
      </header>

      <nav className="mobile-session-picker" aria-label={t("mobile.session")}>
        {project.sessions.map((candidate) => (
          <button
            className="mobile-session-picker__item"
            type="button"
            style={touchTarget}
            data-active={candidate.id === session?.id}
            aria-pressed={candidate.id === session?.id}
            key={candidate.id}
            onClick={() => onSelectSession(candidate.id)}
          >
            <strong>{text(candidate.title)}</strong>
            <span>
              {candidate.runtimeStatus
                ? runtimePhaseLabel(candidate.runtimeStatus.phase, candidate.runtimeStatus.exitCode)
                : statusLabel(candidate.state)}
            </span>
          </button>
        ))}
      </nav>

      {session ? (
        <>
          <nav className="mobile-session-tabs" aria-label={t("mobile.session")}>
            <MobileTab
              id="conversation"
              activeTab={activeTab}
              label={t("mobile.conversation")}
              onSelect={onSelectTab}
            />
            <MobileTab
              id="terminal"
              activeTab={activeTab}
              label={t("mobile.terminal")}
              onSelect={onSelectTab}
            />
            <MobileTab
              id="summary"
              activeTab={activeTab}
              label={t("mobile.summary")}
              onSelect={onSelectTab}
            />
          </nav>

          <div
            className="mobile-session-view__content"
            ref={contentRef}
            aria-label={
              activeTab === "conversation"
                ? t("mobile.conversation")
                : activeTab === "terminal"
                  ? t("mobile.terminal")
                  : t("mobile.summary")
            }
          >
            {activeTab === "conversation" ? (
              <ConversationTab
                key={`${project.path}:${session.id}:${session.runtimeStatus?.runId ?? "no-run"}`}
                session={session}
                state={transcriptState}
                preview={preview}
                scrollRef={contentRef}
              />
            ) : null}
            {activeTab === "terminal" ? (
              <TerminalTab session={session} local={project.source === "local"} />
            ) : null}
            {activeTab === "summary" ? (
              <SummaryTab session={session} state={transcriptState} preview={preview} />
            ) : null}
          </div>
        </>
      ) : (
        <div className="mobile-session-view__empty">{t("mobile.noSession")}</div>
      )}

      <section className="mobile-composer" aria-label={t("mobile.reviewDraft")}>
        <div className="mobile-composer__quick-replies">
          {quickReplyKeys.map((key) => {
            const label = t(key);
            return (
              <button
                type="button"
                style={touchTarget}
                key={key}
                disabled={!session}
                onClick={() => useQuickReply(label)}
              >
                {label}
              </button>
            );
          })}
        </div>

        <textarea
          className="mobile-composer__input"
          value={draft}
          rows={4}
          disabled={!session}
          placeholder={t("mobile.placeholder")}
          aria-label={t("mobile.placeholder")}
          onChange={(event) => updateDraft(event.target.value)}
        />

        <div className="mobile-composer__actions">
          {voiceEnabled ? (
            <button type="button" style={touchTarget} disabled>
              {t("mobile.voiceUnavailable")}
            </button>
          ) : (
            <>
              <span className="mobile-composer__voice-state">{t("mobile.voiceOff")}</span>
              <button type="button" style={touchTarget} onClick={onOpenSettings}>
                {t("mobile.openSettings")}
              </button>
            </>
          )}
          <button
            className="mobile-composer__review"
            type="button"
            style={touchTarget}
            disabled={!session || !draft.trim()}
            onClick={openDraftReview}
          >
            {t("mobile.reviewDraft")}
          </button>
        </div>

        {visibleReview ? (
          <section className="mobile-draft-review" aria-live="polite">
            <h2>{t("mobile.reviewDraft")}</h2>
            <p className="mobile-draft-review__text">{visibleReview}</p>
            <strong className="mobile-draft-review__status">{t("mobile.notSent")}</strong>
            <div className="mobile-draft-review__actions">
              <button type="button" style={touchTarget} onClick={onEditDraft}>
                {t("mobile.editDraft")}
              </button>
              <button type="button" style={touchTarget} disabled>
                {t("mobile.sendUnavailable")}
              </button>
            </div>
          </section>
        ) : null}
      </section>
    </section>
  );
}

interface MobileTabProps {
  id: MobileSessionTab;
  activeTab: MobileSessionTab;
  label: string;
  onSelect: (tab: MobileSessionTab) => void;
}

function MobileTab({ id, activeTab, label, onSelect }: MobileTabProps) {
  const active = id === activeTab;
  return (
    <button
      type="button"
      style={touchTarget}
      aria-pressed={active}
      data-active={active}
      onClick={() => onSelect(id)}
    >
      {label}
    </button>
  );
}

function ConversationTab({
  session,
  state,
  preview,
  scrollRef,
}: {
  session: DevSession;
  state: TranscriptState;
  preview: boolean;
  scrollRef: RefObject<HTMLElement | null>;
}) {
  const { t } = useI18n();
  const [visibleCount, setVisibleCount] = useState(INITIAL_TRANSCRIPT_TURNS);
  const prepareForOlder = useConversationScroll(scrollRef);

  if (!preview && state.kind !== "loaded") return <MobileTranscriptNotice state={state} />;

  const transcript = state.kind === "loaded" ? state.transcript : null;
  const nativeStartIndex = transcript
    ? Math.max(0, transcript.totalEntries - transcript.entries.length)
    : 0;
  const entries = preview
    ? session.conversation.map((entry) => ({
        key: entry.id,
        author: entry.author,
        time: entry.time,
        text: entry.text,
      }))
    : (transcript?.entries ?? []).map((entry, index) => ({
        key: `${entry.at ?? "no-time"}-${nativeStartIndex + index}`,
        author: entry.role === "user" ? ("you" as const) : ("agent" as const),
        time: formatTranscriptTime(entry.at),
        text: entry.text,
      }));
  const visibleEntries = entries.slice(-visibleCount);
  const availableOlder = entries.length - visibleEntries.length;
  const nextPageSize = Math.min(OLDER_TRANSCRIPT_PAGE, availableOlder);
  const unavailableOlder = transcript
    ? Math.max(0, transcript.totalEntries - transcript.entries.length)
    : 0;

  return (
    <div className="mobile-conversation-list">
      {preview ? <p className="conversation-disclaimer">{t("inspector.previewData")}</p> : null}
      {unavailableOlder > 0 ? (
        <p className="conversation-disclaimer">
          {t("transcript.trimmed", { count: unavailableOlder })}
        </p>
      ) : null}
      {availableOlder > 0 ? (
        <button
          className="conversation-list__older"
          type="button"
          onClick={() => {
            prepareForOlder();
            setVisibleCount((current) => current + OLDER_TRANSCRIPT_PAGE);
          }}
        >
          {t("transcript.showOlder", { count: nextPageSize })}
        </button>
      ) : null}
      {visibleEntries.length === 0 ? (
        <p className="conversation-disclaimer">{t("transcript.noMessages")}</p>
      ) : null}
      {visibleEntries.map((entry) => (
        <article className="mobile-conversation-entry" data-author={entry.author} key={entry.key}>
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
    </div>
  );
}

function TerminalTab({ session, local }: { session: DevSession; local: boolean }) {
  const { text } = useI18n();
  if (local)
    return (
      <TerminalLogView sessionId={session.id} currentRunId={session.runtimeStatus?.runId ?? null} />
    );
  return (
    <div className="mobile-terminal" aria-live="off">
      {session.lines.map((line) => (
        <div className="terminal-line" data-tone={line.tone} key={line.id}>
          {text(line.text)}
        </div>
      ))}
    </div>
  );
}

function SummaryTab({
  session,
  state,
  preview,
}: {
  session: DevSession;
  state: TranscriptState;
  preview: boolean;
}) {
  const { t, text } = useI18n();
  if (!preview && state.kind !== "loaded") return <MobileTranscriptNotice state={state} />;

  if (!preview && state.kind === "loaded") {
    const latestReply = latestAssistantExcerpt(state.transcript.entries);
    const lastActivity = formatTranscriptActivity(state.transcript.lastActivity);
    return (
      <div className="mobile-summary">
        <section>
          <h2>{t("inspector.latestReply")}</h2>
          <p className="mobile-summary__outcome">
            {latestReply ?? t("inspector.noAssistantReply")}
          </p>
        </section>
        <section>
          <h2>{t("inspector.lastActivity")}</h2>
          <p>{lastActivity ?? t("inspector.noActivity")}</p>
        </section>
        <MobileChangedFiles files={state.transcript.changedFiles} />
      </div>
    );
  }

  return (
    <div className="mobile-summary">
      <p className="conversation-disclaimer">{t("inspector.previewData")}</p>
      <p className="mobile-summary__outcome">{text(session.summary.outcome)}</p>

      <MobileChangedFiles files={session.summary.changedFiles} />

      <section>
        <h2>{t("inspector.decisions")}</h2>
        {session.summary.decisions.length > 0 ? (
          <ul>
            {session.summary.decisions.map((decision) => (
              <li key={decision}>{decision}</li>
            ))}
          </ul>
        ) : (
          <p>{t("inspector.noDecisions")}</p>
        )}
      </section>

      <section>
        <h2>{t("inspector.nextStep")}</h2>
        <p>{text(session.summary.nextStep)}</p>
      </section>
    </div>
  );
}

function MobileChangedFiles({ files }: { files: readonly string[] }) {
  const { t } = useI18n();
  return (
    <section>
      <h2>{t("inspector.changedFiles")}</h2>
      {files.length > 0 ? (
        <ul>
          {files.map((file) => (
            <li key={file}>
              <code>{file}</code>
            </li>
          ))}
        </ul>
      ) : (
        <p>{t("inspector.noFiles")}</p>
      )}
    </section>
  );
}

function MobileTranscriptNotice({ state }: { state: TranscriptState }) {
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
