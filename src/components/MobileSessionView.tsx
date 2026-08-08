import type { CSSProperties } from "react";
import type { DevSession, Project } from "../domain";
import { useI18n } from "../i18n";

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
  const { statusLabel, t } = useI18n();
  const visibleReview = reviewedDraft === draft ? reviewedDraft : null;

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
          <h1>{session?.title ?? t("mobile.noSession")}</h1>
        </div>
        {session ? (
          <span className="state-badge" data-state={session.state}>
            {statusLabel(session.state)}
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
            <strong>{candidate.title}</strong>
            <span>{statusLabel(candidate.state)}</span>
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
            aria-label={
              activeTab === "conversation"
                ? t("mobile.conversation")
                : activeTab === "terminal"
                  ? t("mobile.terminal")
                  : t("mobile.summary")
            }
          >
            {activeTab === "conversation" ? <ConversationTab session={session} /> : null}
            {activeTab === "terminal" ? <TerminalTab session={session} /> : null}
            {activeTab === "summary" ? <SummaryTab session={session} /> : null}
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

function ConversationTab({ session }: { session: DevSession }) {
  const { t } = useI18n();
  return (
    <div className="mobile-conversation-list">
      {session.conversation.map((entry) => (
        <article className="mobile-conversation-entry" data-author={entry.author} key={entry.id}>
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

function TerminalTab({ session }: { session: DevSession }) {
  return (
    <div className="mobile-terminal" aria-live="off">
      {session.lines.map((line) => (
        <div className="terminal-line" data-tone={line.tone} key={line.id}>
          {line.text}
        </div>
      ))}
    </div>
  );
}

function SummaryTab({ session }: { session: DevSession }) {
  const { t } = useI18n();
  return (
    <div className="mobile-summary">
      <p className="mobile-summary__outcome">{session.summary.outcome}</p>

      <section>
        <h2>{t("inspector.changedFiles")}</h2>
        {session.summary.changedFiles.length > 0 ? (
          <ul>
            {session.summary.changedFiles.map((file) => (
              <li key={file}>
                <code>{file}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p>{t("inspector.noFiles")}</p>
        )}
      </section>

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
        <p>{session.summary.nextStep}</p>
      </section>
    </div>
  );
}
