import { useState } from "react";
import { useI18n } from "../i18n";
import { sortByRecentActivity } from "../runtime/liveSessionPresentation";
import { type LiveSession, errorMessage, sessionClient } from "../runtime/sessionClient";
import { releaseTerminal } from "../terminalInstances";
import { releaseDetachedTerminalLog } from "../terminalLogInstances";
import type { LiveSessionsState } from "../runtime/useLiveSessions";
import { ageLabel, programLabel } from "./liveSessionLabels";

/**
 * Sessions the broker still holds that no pane in this workspace refers to.
 *
 * Closing a pane detaches rather than kills — that is the feature that lets an agent keep working
 * — but nothing ever listed what was left behind, so shells accumulated for days, invisible, and
 * an agent inside one held its own files open against the next launch. This is the missing
 * `tmux ls` and `tmux kill-session`: what is running, where, since when, and when it last said
 * anything, so a forgotten shell can be told from an agent mid-task.
 */
export function OrphanSessions({
  knownSessionIds,
  live,
}: {
  knownSessionIds: ReadonlySet<string>;
  live: LiveSessionsState;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<string | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);

  const orphans = sortByRecentActivity(
    live.sessions.filter((session) => !knownSessionIds.has(session.sessionId)),
  );
  if (!sessionClient.available()) return null;
  const error = stopError ?? live.error;

  async function stop(session: LiveSession) {
    setBusy(session.sessionId);
    try {
      // kill sweeps the whole process tree, so an agent inside the shell goes with it.
      await sessionClient.kill(session.sessionId, session.runId);
      await sessionClient.discard(session.sessionId).catch(() => {
        // A session still draining refuses discard; the kill is what mattered.
      });
      // An orphan has no pane by definition, but its emulator can still be retained from before
      // the pane closed; the session is gone from the broker, so nothing should hold it open.
      releaseTerminal(session.sessionId);
      releaseDetachedTerminalLog(session.sessionId);
      setStopError(null);
    } catch (cause: unknown) {
      setStopError(errorMessage(cause));
    } finally {
      setBusy(null);
      await live.refresh();
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
          <button type="button" onClick={() => void live.refresh()}>
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
      {live.unsupported ? (
        <output className="orphan-sessions__error">{t("orphans.unsupported")}</output>
      ) : null}
      {live.unsupported ? null : orphans.length === 0 ? (
        <p className="orphan-sessions__empty">{t("orphans.empty")}</p>
      ) : (
        <ul>
          {orphans.map((session) => (
            <li key={session.sessionId}>
              <span className="orphan-sessions__identity">
                <code>{session.sessionId}</code>
                <small>
                  <strong>{programLabel(t, session)}</strong>
                  {session.cwd ? <span title={session.cwd}> · {session.cwd}</span> : null}
                </small>
              </span>
              <span className="orphan-sessions__activity">
                <span>
                  {t("orphans.lastOutput", {
                    age: ageLabel(t, live.observedAtMs, session.lastOutputMs, "age.never"),
                  })}
                </span>
                <small>
                  {t("orphans.started", {
                    age: ageLabel(t, live.observedAtMs, session.startedAtMs, "age.unknown"),
                  })}
                </small>
              </span>
              <span className="orphan-sessions__state">
                <span data-running={session.running}>
                  {session.running ? t("orphans.running") : t("orphans.finished")}
                </span>
                <small className="orphan-sessions__pid">
                  {session.processId === null
                    ? t("orphans.noPid")
                    : t("orphans.pid", { pid: session.processId })}
                </small>
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
