import type { AppSection, Project, SidebarMode } from "../domain";
import { useI18n } from "../i18n";
import { Icon, type IconName } from "./Icon";

interface SidebarProps {
  projects: readonly Project[];
  activeProjectId: string;
  activeSection: AppSection;
  mode: SidebarMode;
  onSelectProject: (projectId: string) => void;
  onSelectSection: (section: AppSection) => void;
  settingsShortcut: string;
}

export function Sidebar({
  projects,
  activeProjectId,
  activeSection,
  mode,
  onSelectProject,
  onSelectSection,
  settingsShortcut,
}: SidebarProps) {
  const { t } = useI18n();
  const sections: { id: AppSection; label: string; hint: string; icon: IconName }[] = [
    {
      id: "attention",
      label: t("nav.attention"),
      hint: t("nav.attentionHint"),
      icon: "bell",
    },
    { id: "workspace", label: t("nav.workspace"), hint: t("nav.workspaceHint"), icon: "grid" },
    { id: "sessions", label: t("nav.sessions"), hint: t("nav.sessionsHint"), icon: "sessions" },
    { id: "activity", label: t("nav.activity"), hint: t("nav.activityHint"), icon: "activity" },
  ];
  return (
    <aside className="sidebar" data-mode={mode} aria-label={t("sidebar.aria")}>
      <div className="brand">
        <div className="brand__mark">T</div>
        <div>
          <strong>talkak</strong>
          <span>DEV WORKSPACE</span>
        </div>
      </div>

      <nav className="primary-nav" aria-label={t("sidebar.primaryNav")}>
        {sections.map((section) => (
          <button
            className="nav-item"
            data-active={activeSection === section.id}
            key={section.id}
            type="button"
            onClick={() => onSelectSection(section.id)}
          >
            <span className="nav-item__icon">
              <Icon name={section.icon} />
            </span>
            <span>
              <strong>{section.label}</strong>
              <small>{section.hint}</small>
            </span>
          </button>
        ))}
      </nav>

      <div className="sidebar__section-heading">
        <span>{t("sidebar.projects")}</span>
        <button
          type="button"
          aria-label={t("sidebar.addProject")}
          title={t("common.comingSoon")}
          disabled
        >
          <Icon name="plus" size={15} />
        </button>
      </div>

      <div className="project-list">
        {projects.map((project) => (
          <button
            className="project-item"
            data-active={activeProjectId === project.id}
            key={project.id}
            type="button"
            onClick={() => onSelectProject(project.id)}
          >
            <span
              className="project-item__mark"
              style={{ "--project-color": project.color } as React.CSSProperties}
            >
              {project.monogram}
            </span>
            <span className="project-item__copy">
              <strong>{project.name}</strong>
              <small>{t("sidebar.sessionCount", { count: project.sessions.length })}</small>
            </span>
            <Icon name="chevron" size={14} />
          </button>
        ))}
      </div>

      <div className="sidebar__spacer" />

      <div className="runtime-card">
        <span className="runtime-card__pulse" />
        <div>
          <strong>{t("sidebar.localWorkspace")}</strong>
          <small>{t("sidebar.runtimePending")}</small>
        </div>
      </div>

      <button
        className="sidebar-action"
        type="button"
        data-active={activeSection === "settings"}
        onClick={() => onSelectSection("settings")}
      >
        <Icon name="settings" />
        <span>{t("sidebar.settings")}</span>
        <span className="sidebar-action__key">{settingsShortcut}</span>
      </button>
    </aside>
  );
}
