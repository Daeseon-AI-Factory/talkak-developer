import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { type LiveSession, errorMessage, sessionClient } from "../runtime/sessionClient";

/**
 * Sessions the broker still holds that no pane in this workspace refers to.
 *
 * Closing a pane detaches rather than kills — that is the feature that lets an agent keep working
 * — but nothing ever listed what was left behind, so shells accumulated for days, invisible, and
 * an agent inside one held its own files open against the next launch. This is the missing
 * `tmux ls` and `tmux kill-session`.
 */
export function OrphanSessions({ knownSessionIds }: { knownSessionIds: ReadonlySet<string> }) {
  const { t } = useI18n();
  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [unsupported, setUnsupported] = useState(false);

  const refresh = useCallback(async () => {
    if (!sessionClient.available()) return;
    try {
      setSessions(await sessionClient.liveSessions());
      setError(null);
      setUnsupported(false);
    } catch (cause: unknown) {
      // A broker started before this feature existed does not know the request. Saying so beats
      // an empty list, which would claim there is nothing to clean up while dozens run.
      const message = errorMessage(cause);
      setSessions([]);
      if (/bad request|unexpected broker response/i.test(message)) {
        setUnsupported(true);
        setError(null);
      } else {
        setUnsupported(false);
        setError(message);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const orphans = sessions.filter((session) => !knownSessionIds.has(session.sessionId));
  if (!sessionClient.available()) return null;

  async function stop(session: LiveSession) {
    setBusy(session.sessionId);
    try {
      // kill sweeps the whole process tree, so an agent inside the shell goes with it.
      await sessionClient.kill(session.sessionId, session.runId);
      await sessionClient.discard(session.sessionId).catch(() => {
        // A session still draining refuses discard; the kill is what mattered.
      });
      setError(null);
    } catch (cause: unknown) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
      await refresh();
    }
  }

  async function stopAll() {
    for (const session of orphans) await stop(session);
  }

  return (
    <section className="orphan-sessions" aria-label={t("orphans.aria")}>
      <header>
        <div>
          <span className="orphan-sessions__eyebrow">{t("orphans.eyebrow")}</span>
          <strong>{t("orphans.title", { count: orphans.length })}</strong>
        </div>
        <div className="orphan-sessions__actions">
          <button type="button" onClick={() => void refresh()}>
            {t("orphans.refresh")}
          </button>
          {orphans.length > 0 ? (
            <button type="button" data-tone="danger" onClick={() => void stopAll()}>
              {t("orphans.stopAll")}
            </button>
          ) : null}
        </div>
      </header>
      <p className="orphan-sessions__description">{t("orphans.description")}</p>
      {error ? <output className="orphan-sessions__error">{error}</output> : null}
      {unsupported ? (
        <output className="orphan-sessions__error">{t("orphans.unsupported")}</output>
      ) : null}
      {unsupported ? null : orphans.length === 0 ? (
        <p className="orphan-sessions__empty">{t("orphans.empty")}</p>
      ) : (
        <ul>
          {orphans.map((session) => (
            <li key={session.sessionId}>
              <code>{session.sessionId}</code>
              <span data-running={session.running}>
                {session.running ? t("orphans.running") : t("orphans.finished")}
              </span>
              <span className="orphan-sessions__pid">
                {session.processId === null
                  ? t("orphans.noPid")
                  : t("orphans.pid", { pid: session.processId })}
              </span>
              <button
                type="button"
                disabled={busy === session.sessionId}
                onClick={() => void stop(session)}
              >
                {busy === session.sessionId ? t("orphans.stopping") : t("orphans.stop")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
