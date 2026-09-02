import type { Project } from "../domain";
import { useI18n } from "../i18n";
import { liveSessionsById } from "../runtime/liveSessionPresentation";
import { useLiveSessions } from "../runtime/useLiveSessions";
import { runtimeLabel } from "../workspaceModel";
import { Icon } from "./Icon";
import { OrphanSessions } from "./OrphanSessions";
import { ageLabel } from "./liveSessionLabels";

interface CollectionViewProps {
  projects: readonly Project[];
  onOpenSession: (projectId: string, sessionId: string) => void;
}

/** How often the Sessions screen asks the broker what it holds while it is on screen. */
const LIVE_SESSIONS_INTERVAL_MS = 5000;

export function SessionsView({ projects, onOpenSession }: CollectionViewProps) {
  const { runtimePhaseLabel, statusLabel, t, text } = useI18n();
  const live = useLiveSessions(LIVE_SESSIONS_INTERVAL_MS);
  const liveById = liveSessionsById(live.sessions);
  const rows = projects.flatMap((project) =>
    project.sessions.map((session) => ({ project, session })),
  );
  const knownSessionIds = new Set(rows.map(({ session }) => session.id));

  return (
    <div className="collection-screen">
      <CollectionHeader
        eyebrow={t("sessions.eyebrow")}
        title={t("sessions.title")}
        description={t("sessions.description")}
      />
      <OrphanSessions knownSessionIds={knownSessionIds} live={live} />
      <section className="session-table" aria-label={t("sessions.tableAria")}>
        <div className="session-table__head">
          <span>{t("sessions.session")}</span>
          <span>{t("sessions.project")}</span>
          <span>{t("sessions.runtime")}</span>
          <span>{t("sessions.state")}</span>
          <span>{t("sessions.lastOutput")}</span>
          <span>{t("sessions.started")}</span>
          <span />
        </div>
        {rows.map(({ project, session }) => {
          // The broker's own view of this session, when it holds one: the same rows the orphan
          // list is built from, so the two never disagree.
          const broker = liveById.get(session.id);
          return (
            <button
              className="session-row"
              type="button"
              key={session.id}
              onClick={() => onOpenSession(project.id, session.id)}
            >
              <span className="session-row__title">
                <span className="session-row__icon">
                  <Icon name="terminal" size={16} />
                </span>
                <span>
                  <strong>{text(session.title)}</strong>
                  <small>{text(session.profile)}</small>
                </span>
              </span>
              <span>{project.name}</span>
              <span>
                {session.runtime.kind === "unconfigured"
                  ? t("runtime.unconfigured")
                  : text(runtimeLabel(session))}
              </span>
              <span
                className="state-badge"
                data-testid="session-runtime-status"
                data-state={session.state}
                data-runtime-phase={session.runtimeStatus?.phase}
              >
                {session.runtimeStatus
                  ? runtimePhaseLabel(session.runtimeStatus.phase, session.runtimeStatus.exitCode)
                  : statusLabel(session.state)}
              </span>
              <span className="session-row__age">
                {broker
                  ? ageLabel(t, live.observedAtMs, broker.lastOutputMs, "age.never")
                  : t("sessions.noLiveRun")}
              </span>
              <span className="session-row__age">
                {broker
                  ? ageLabel(t, live.observedAtMs, broker.startedAtMs, "age.unknown")
                  : t("sessions.noLiveRun")}
              </span>
              <span className="session-row__open">
                {t("sessions.open")} <Icon name="chevron" size={13} />
              </span>
            </button>
          );
        })}
      </section>
    </div>
  );
}

export function ActivityView({ projects, onOpenSession }: CollectionViewProps) {
  const { t, text } = useI18n();
  const entries = projects
    .flatMap((project) =>
      project.sessions.flatMap((session) =>
        session.conversation.map((entry) => ({ project, session, entry })),
      ),
    )
    .slice(0, 8);

  return (
    <div className="collection-screen">
      <CollectionHeader
        eyebrow={t("activity.eyebrow")}
        title={t("activity.title")}
        description={t("activity.description")}
      />
      <div className="activity-feed">
        {entries.map(({ project, session, entry }, index) => (
          <button
            className="activity-row"
            type="button"
            key={`${session.id}-${entry.id}`}
            onClick={() => onOpenSession(project.id, session.id)}
          >
            <span className="activity-row__rail">
              <span data-author={entry.author} />
              {index < entries.length - 1 ? <i /> : null}
            </span>
            <span className="activity-row__content">
              <span className="activity-row__meta">
                <strong>{project.name}</strong>
                <span>/</span>
                <span>{text(session.title)}</span>
                <time>{entry.time}</time>
              </span>
              <span className="activity-row__message">{entry.text}</span>
            </span>
            <Icon name="chevron" size={14} />
          </button>
        ))}
      </div>
    </div>
  );
}

interface CollectionHeaderProps {
  eyebrow: string;
  title: string;
  description: string;
}

function CollectionHeader({ eyebrow, title, description }: CollectionHeaderProps) {
  return (
    <header className="collection-header">
      <span>{eyebrow}</span>
      <h1>{title}</h1>
      <p>{description}</p>
    </header>
  );
}
