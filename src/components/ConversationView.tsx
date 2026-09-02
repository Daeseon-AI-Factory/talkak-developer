import { Fragment, type RefObject, useMemo, useRef, useState } from "react";
import { useConversationScroll } from "../conversationScroll";
import type { DevSession } from "../domain";
import { useI18n } from "../i18n";
import {
  INITIAL_TRANSCRIPT_TURNS,
  OLDER_TRANSCRIPT_PAGE,
  conversationDisplayEntries,
  transcriptDayKey,
  transcriptDayLabel,
} from "../runtime/transcriptPresentation";
import type { TranscriptState } from "../runtime/useAgentTranscript";
import { ConversationDaySeparator, ConversationEntry } from "./ConversationEntry";

/**
 * The conversation log, shared by the inspector and the phone view.
 *
 * Only the newest turns mount; older ones come in pages on request, so a long session never
 * mounts hundreds of markdown bodies at once. The display list is derived once per transcript
 * object — the transcript hook hands back the same object while the record is unchanged, so a
 * poll that found nothing costs no re-mapping and no re-render here.
 */
interface ConversationViewProps {
  session: DevSession;
  state: TranscriptState;
  preview: boolean;
  className: string;
  /** The inspector scrolls its own list; the phone view hands in the parent's scroller. */
  scrollRef?: RefObject<HTMLElement | null>;
  /** Message count and record source above the list. The phone view has no room for it. */
  showMeta?: boolean;
}

export function ConversationView({
  session,
  state,
  preview,
  className,
  scrollRef,
  showMeta = false,
}: ConversationViewProps) {
  const { t } = useI18n();
  const [visibleCount, setVisibleCount] = useState(INITIAL_TRANSCRIPT_TURNS);
  const ownRef = useRef<HTMLDivElement | null>(null);
  const prepareForOlder = useConversationScroll(scrollRef ?? ownRef);
  const transcript = state.kind === "loaded" ? state.transcript : null;
  const conversation = session.conversation;
  const entries = useMemo(
    () => conversationDisplayEntries(conversation, transcript, preview),
    [conversation, transcript, preview],
  );
  const attachRef = scrollRef ? undefined : ownRef;

  if (!preview && state.kind !== "loaded") {
    return (
      <div className={className} ref={attachRef}>
        <TranscriptNotice state={state} />
      </div>
    );
  }

  const totalEntries = preview ? entries.length : (transcript?.totalEntries ?? entries.length);
  const visibleEntries = entries.slice(-visibleCount);
  const availableOlder = entries.length - visibleEntries.length;
  const nextPageSize = Math.min(OLDER_TRANSCRIPT_PAGE, availableOlder);
  const unavailableOlder = Math.max(0, totalEntries - entries.length);
  const dayLabels = { today: t("conversation.today"), yesterday: t("conversation.yesterday") };

  return (
    <div className={className} ref={attachRef}>
      {showMeta ? (
        <div className="conversation-list__meta">
          <span>{t("inspector.messageCount", { count: totalEntries })}</span>
          <span>
            {preview
              ? t("inspector.previewData")
              : t("transcript.source", { source: transcript?.source ?? "" })}
          </span>
        </div>
      ) : preview ? (
        <p className="conversation-disclaimer">{t("inspector.previewData")}</p>
      ) : null}
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
      {visibleEntries.map((entry, index) => {
        const day = transcriptDayKey(entry.at);
        const previousDay =
          index === 0 ? "" : transcriptDayKey(visibleEntries[index - 1]?.at ?? null);
        const startsDay = entry.at !== null && day !== "" && day !== previousDay;
        return (
          <Fragment key={entry.key}>
            {startsDay && entry.at ? (
              <ConversationDaySeparator label={transcriptDayLabel(entry.at, dayLabels)} />
            ) : null}
            <ConversationEntry entry={entry} />
          </Fragment>
        );
      })}
    </div>
  );
}

/** Says why there is nothing to show, which is never the same as showing nothing. */
export function TranscriptNotice({ state }: { state: TranscriptState }) {
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
