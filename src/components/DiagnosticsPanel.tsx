import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../i18n";
import {
  type BrokerLogTail,
  brokerLogClient,
  countProblems,
  filterLogLines,
  logLinesAsText,
} from "../runtime/brokerLogClient";
import { clipboardClient } from "../runtime/clipboardClient";
import { errorMessage } from "../runtime/sessionClient";

/** How often the open panel re-reads the tail. Lifecycle events only, so this is plenty. */
const REFRESH_INTERVAL_MS = 4000;
const TAIL_LIMIT = 500;

/**
 * The broker's lifecycle log, under Settings. Collapsed until asked for: it is a diagnostics
 * surface, and Settings is not the place to be greeted by a log. It shows the session broker's
 * log and nothing else — the app has no runtime log of its own — and says so in its caption.
 */
export function DiagnosticsPanel() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [problemsOnly, setProblemsOnly] = useState(true);
  const [query, setQuery] = useState("");
  const [tail, setTail] = useState<BrokerLogTail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const available = brokerLogClient.available();

  const load = useCallback(async () => {
    if (!available) return;
    try {
      setTail(await brokerLogClient.tail(problemsOnly, TAIL_LIMIT));
      setError(null);
    } catch (cause: unknown) {
      setError(errorMessage(cause));
    }
  }, [available, problemsOnly]);

  useEffect(() => {
    if (!open) return;
    void load();
    const timer = setInterval(() => void load(), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load, open]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const shown = filterLogLines(tail?.lines ?? [], query);

  async function copy() {
    try {
      await clipboardClient.writeText(logLinesAsText(shown));
      setCopied(true);
    } catch (cause: unknown) {
      setError(errorMessage(cause));
    }
  }

  return (
    <section className="diagnostics-panel" aria-labelledby="diagnostics-title">
      <header className="diagnostics-panel__header">
        <div>
          <span>{t("diagnostics.eyebrow")}</span>
          <h2 id="diagnostics-title">{t("diagnostics.title")}</h2>
          <p>{t("diagnostics.description")}</p>
        </div>
        <button
          type="button"
          data-testid="diagnostics-toggle"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          {open ? t("diagnostics.close") : t("diagnostics.open")}
        </button>
      </header>
      {open ? (
        <div className="diagnostics-panel__body">
          {!available ? (
            <p className="diagnostics-panel__notice">{t("diagnostics.browserOnly")}</p>
          ) : (
            <>
              <div className="diagnostics-panel__controls">
                <label>
                  <input
                    type="checkbox"
                    checked={problemsOnly}
                    onChange={(event) => setProblemsOnly(event.target.checked)}
                  />
                  <span>{t("diagnostics.problemsOnly")}</span>
                  <small>{t("diagnostics.problemsHeuristic")}</small>
                </label>
                <input
                  type="search"
                  value={query}
                  aria-label={t("diagnostics.filter")}
                  placeholder={t("diagnostics.filterPlaceholder")}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <button type="button" onClick={() => void load()}>
                  {t("diagnostics.refresh")}
                </button>
                <button type="button" disabled={shown.length === 0} onClick={() => void copy()}>
                  {copied ? t("diagnostics.copied") : t("diagnostics.copy")}
                </button>
              </div>
              <p className="diagnostics-panel__caption">
                <span>
                  {tail?.path
                    ? t("diagnostics.path", { path: tail.path })
                    : t("diagnostics.noPath")}
                </span>
                <span>{t("diagnostics.autoRefresh")}</span>
                {tail?.partial ? <span>{t("diagnostics.partial")}</span> : null}
                {tail ? (
                  <span>
                    {t("diagnostics.lineCount", { count: shown.length })} ·{" "}
                    {t("diagnostics.problemCount", { count: countProblems(shown) })}
                  </span>
                ) : null}
              </p>
              {error ? <output className="diagnostics-panel__error">{error}</output> : null}
              {tail && !tail.present ? (
                <p className="diagnostics-panel__notice">{t("diagnostics.absent")}</p>
              ) : tail && shown.length === 0 ? (
                <p className="diagnostics-panel__notice">{t("diagnostics.empty")}</p>
              ) : (
                <ol className="diagnostics-panel__lines" data-testid="diagnostics-lines">
                  {shown.map((line, index) => (
                    <li key={`${index}-${line.text}`} data-level={line.level}>
                      {line.text}
                    </li>
                  ))}
                </ol>
              )}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
