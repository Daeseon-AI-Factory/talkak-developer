import type { Project } from "../domain";
import { useI18n } from "../i18n";
import type { SessionCounts } from "../workspaceModel";
import { Icon } from "./Icon";

interface WorkspaceHeaderProps {
  project: Project;
  counts: SessionCounts;
  onCreateSession: () => void;
}

export function WorkspaceHeader({ project, counts, onCreateSession }: WorkspaceHeaderProps) {
  const { t } = useI18n();
  return (
    <header className="workspace-header">
      <div className="workspace-header__identity">
        <div className="workspace-header__eyebrow">
          <span>{t("header.project")}</span>
          <span className="workspace-header__separator">/</span>
          <span>{project.description}</span>
        </div>
        <div className="workspace-header__title-row">
          <h1>{project.name}</h1>
          <span className="branch-chip">
            <Icon name="branch" size={14} />
            {project.branch}
          </span>
        </div>
        <div className="workspace-header__path">
          <Icon name="folder" size={14} />
          <span>{project.path}</span>
        </div>
      </div>

      <div className="workspace-header__actions">
        <dl className="session-stats" aria-label={t("header.statsAria")}>
          <div>
            <dt>{counts.working}</dt>
            <dd>{t("header.working")}</dd>
          </div>
          <div data-alert={counts.needsInput > 0}>
            <dt>{counts.needsInput}</dt>
            <dd>{t("header.needsInput")}</dd>
          </div>
          <div>
            <dt>{counts.ready}</dt>
            <dd>{t("header.ready")}</dd>
          </div>
        </dl>
        <button className="button button--primary" type="button" onClick={onCreateSession}>
          <Icon name="plus" size={17} />
          {t("header.newSession")}
        </button>
      </div>
    </header>
  );
}
