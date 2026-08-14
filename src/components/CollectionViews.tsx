import type { Project } from "../domain";
import { useI18n } from "../i18n";
import { runtimeLabel } from "../workspaceModel";
import { Icon } from "./Icon";

interface CollectionViewProps {
  projects: readonly Project[];
  onOpenSession: (projectId: string, sessionId: string) => void;
}

export function SessionsView({ projects, onOpenSession }: CollectionViewProps) {
  const { statusLabel, t, text } = useI18n();
  const rows = projects.flatMap((project) =>
    project.sessions.map((session) => ({ project, session })),
  );

  return (
    <div className="collection-screen">
      <CollectionHeader
        eyebrow={t("sessions.eyebrow")}
        title={t("sessions.title")}
        description={t("sessions.description")}
      />
      <section className="session-table" aria-label={t("sessions.tableAria")}>
        <div className="session-table__head">
          <span>{t("sessions.session")}</span>
          <span>{t("sessions.project")}</span>
          <span>{t("sessions.runtime")}</span>
          <span>{t("sessions.state")}</span>
          <span />
        </div>
        {rows.map(({ project, session }) => (
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
            <span className="state-badge" data-state={session.state}>
              {statusLabel(session.state)}
            </span>
            <span className="session-row__open">
              {t("sessions.open")} <Icon name="chevron" size={13} />
            </span>
          </button>
        ))}
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
