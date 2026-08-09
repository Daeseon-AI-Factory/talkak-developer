import type { DevSession, LaunchProfile, Project } from "../domain";
import { type Locale, useI18n } from "../i18n";
import { runtimeLabel } from "../workspaceModel";
import { Icon } from "./Icon";

interface CollectionViewProps {
  projects: readonly Project[];
  onOpenSession: (projectId: string, sessionId: string) => void;
}

export function SessionsView({ projects, onOpenSession }: CollectionViewProps) {
  const { statusLabel, t } = useI18n();
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
                <strong>{session.title}</strong>
                <small>{session.profile}</small>
              </span>
            </span>
            <span>{project.name}</span>
            <span>
              {session.runtime.kind === "unconfigured"
                ? t("runtime.unconfigured")
                : runtimeLabel(session)}
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
  const { t } = useI18n();
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
                <span>{session.title}</span>
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

export function createPreviewSession(
  index: number,
  locale: Locale,
  launchProfile: LaunchProfile,
): DevSession {
  const korean = locale === "ko";
  const storedLaunchProfile = { ...launchProfile, args: [...launchProfile.args] };
  return {
    id: `preview-session-${index}`,
    title: korean ? `새 세션 ${index}` : `New session ${index}`,
    profile: launchProfile.label || (korean ? "기본 터미널" : "Default terminal"),
    launchProfile: storedLaunchProfile,
    state: "idle",
    runtime: { kind: "unconfigured", label: "Runtime 미선택", shell: "—" },
    branch: "main",
    startedAt: "now",
    lastActivity: korean ? "방금 생성" : "Created now",
    lines: [
      {
        id: `preview-${index}-1`,
        tone: "muted",
        text: korean ? "세션 셸을 만들었습니다." : "Session shell created.",
      },
      {
        id: `preview-${index}-2`,
        tone: "warning",
        text: korean
          ? "작업 폴더를 확인한 뒤 로컬 셸을 명시적으로 시작하세요."
          : "Confirm the working directory, then start the local shell explicitly.",
      },
    ],
    conversation: [
      {
        id: `preview-conversation-${index}`,
        author: "system",
        time: "now",
        text: korean
          ? "미리보기 세션만 생성했으며 프로세스는 시작하지 않았습니다."
          : "Preview session created. No process was started.",
      },
    ],
    summary: {
      outcome: korean
        ? "실행 프로필과 런타임을 선택해야 합니다."
        : "Choose a launch profile and runtime.",
      progress: 0,
      changedFiles: [],
      decisions: [],
      nextStep: korean
        ? "작업 폴더를 확인하고 로컬 셸을 시작합니다."
        : "Confirm the working directory and start the local shell.",
    },
  };
}
