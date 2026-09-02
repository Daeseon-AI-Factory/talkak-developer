import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  type ReactNode,
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useI18n } from "../i18n";
import { clipboardClient } from "../runtime/clipboardClient";
import type { TranscriptDecision } from "../runtime/transcriptClient";
import { type DisplayConversationEntry, toolSummary } from "../runtime/transcriptPresentation";

/**
 * One turn of the conversation log: markdown body, the tools it ran, the questions it asked.
 *
 * The text stays plain DOM so a drag selection and the system copy keep working; the copy buttons
 * are for the cases selection is clumsy at — a whole message, a fenced command, one inline token.
 * A copy that the clipboard refused says so: this app once shipped a refusal that looked like a
 * success, and a second time would be a choice.
 */

type CopyStatus = "idle" | "copied" | "failed";

const COPY_FEEDBACK_MS = 1400;

function useCopyFeedback(): { status: CopyStatus; copy: (text: string) => void } {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback((text: string) => {
    void clipboardClient
      .writeText(text)
      .then(
        () => setStatus("copied"),
        () => setStatus("failed"),
      )
      .then(() => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setStatus("idle"), COPY_FEEDBACK_MS);
      });
  }, []);
  return { status, copy };
}

function copyStatusLabel(status: CopyStatus, t: ReturnType<typeof useI18n>["t"]): string {
  if (status === "copied") return t("conversation.copied");
  if (status === "failed") return t("conversation.copyFailed");
  return t("conversation.copy");
}

function CopyButton({ label, read }: { label: string; read: () => string }) {
  const { t } = useI18n();
  const { status, copy } = useCopyFeedback();
  return (
    <button
      type="button"
      className="conversation-copy"
      data-status={status}
      aria-label={label}
      title={label}
      onClick={() => copy(read())}
    >
      {copyStatusLabel(status, t)}
    </button>
  );
}

/** Whether a `code` element sits inside a fenced block, where the block owns the copy button. */
const InsideCodeBlock = createContext(false);

function CodeBlock({ children }: { children?: ReactNode }) {
  const { t } = useI18n();
  const ref = useRef<HTMLPreElement | null>(null);
  return (
    <div className="conversation-code">
      <CopyButton label={t("conversation.copyCode")} read={() => ref.current?.textContent ?? ""} />
      <InsideCodeBlock.Provider value={true}>
        <pre ref={ref}>{children}</pre>
      </InsideCodeBlock.Provider>
    </div>
  );
}

function MarkdownCode({ className, children }: { className?: string; children?: ReactNode }) {
  const inBlock = useContext(InsideCodeBlock);
  if (inBlock) return <code className={className}>{children}</code>;
  return <InlineCode className={className}>{children}</InlineCode>;
}

function InlineCode({ className, children }: { className?: string; children?: ReactNode }) {
  const { t } = useI18n();
  const { status, copy } = useCopyFeedback();
  const ref = useRef<HTMLElement | null>(null);
  const copyToken = () => copy(ref.current?.textContent ?? "");
  return (
    <span className="conversation-inline-code" data-status={status}>
      <code
        ref={ref}
        className={className}
        // biome-ignore lint/a11y/useSemanticElements: a button's contents drop out of a drag selection; the token must stay selectable text
        role="button"
        tabIndex={0}
        title={t("conversation.copyInline")}
        onClick={copyToken}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            copyToken();
          }
        }}
      >
        {children}
      </code>
      {status !== "idle" ? (
        <span className="conversation-copy__state" data-status={status}>
          {copyStatusLabel(status, t)}
        </span>
      ) : null}
    </span>
  );
}

/**
 * A web link opens in the OS browser; the WebView must never navigate away from the workspace.
 * Anything else (a relative path, an unknown scheme) has nowhere to go here, so it is not
 * dressed up as a link.
 */
function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  if (!href || !isExternalLink(href)) return <>{children}</>;
  return (
    <a
      href={href}
      rel="noreferrer"
      target="_blank"
      onClick={(event) => {
        event.preventDefault();
        openExternalLink(href);
      }}
    >
      {children}
    </a>
  );
}

function isExternalLink(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href);
}

function openExternalLink(href: string): void {
  if (isTauri()) {
    void openUrl(href).catch(() => undefined);
    return;
  }
  window.open(href, "_blank", "noreferrer");
}

const markdownComponents: Components = {
  pre: CodeBlock,
  code: MarkdownCode,
  a: MarkdownLink,
};

const remarkPlugins = [remarkGfm];

function Decisions({ decisions }: { decisions: readonly TranscriptDecision[] }) {
  const { t } = useI18n();
  return (
    <div className="conversation-decisions" aria-label={t("conversation.decisionsAria")}>
      {decisions.map((decision) => {
        // A free-text answer is not among the offered options; still show what was answered.
        const options =
          decision.selected !== null && !decision.options.includes(decision.selected)
            ? [...decision.options, decision.selected]
            : decision.options;
        return (
          <section className="conversation-decision" key={decision.question}>
            <strong>{decision.question}</strong>
            <ul>
              {options.map((option) => {
                const picked = option === decision.selected;
                return (
                  <li key={option} data-selected={picked}>
                    <span>{option}</span>
                    {picked ? <em>{t("conversation.selected")}</em> : null}
                  </li>
                );
              })}
            </ul>
            {decision.selected === null ? <small>{t("conversation.noSelection")}</small> : null}
          </section>
        );
      })}
    </div>
  );
}

export const ConversationEntry = memo(function ConversationEntry({
  entry,
}: {
  entry: DisplayConversationEntry;
}) {
  const { t } = useI18n();
  const author =
    entry.author === "you"
      ? t("inspector.you")
      : entry.author === "agent"
        ? t("inspector.agent")
        : t("inspector.system");
  return (
    <article className="conversation-entry" data-author={entry.author}>
      <header>
        <strong>{author}</strong>
        <span className="conversation-entry__actions">
          {entry.text ? (
            <CopyButton label={t("conversation.copyMessage")} read={() => entry.text} />
          ) : null}
          <time dateTime={entry.at ?? undefined}>{entry.time}</time>
        </span>
      </header>
      {entry.decisions.length > 0 ? <Decisions decisions={entry.decisions} /> : null}
      {entry.text ? (
        <div className="conversation-entry__body">
          <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents}>
            {entry.text}
          </ReactMarkdown>
        </div>
      ) : null}
      {entry.tools.length > 0 ? (
        <footer className="conversation-entry__tools">
          {t("conversation.tools", { summary: toolSummary(entry.tools) })}
        </footer>
      ) : null}
    </article>
  );
});

export function ConversationDaySeparator({ label }: { label: string }) {
  return <div className="conversation-day">{label}</div>;
}
