import { useEffect, useRef, useState } from "react";
import type { AppSection, Project, SidebarMode } from "../domain";
import { useI18n } from "../i18n";
import type { DesktopPlatform } from "../platform";
import { errorMessage } from "../runtime/sessionClient";
import { Icon, type IconName } from "./Icon";

interface SidebarProps {
  projects: readonly Project[];
  activeProjectId: string;
  activeSection: AppSection;
  attentionCount: number;
  mode: SidebarMode;
  platform: DesktopPlatform;
  onSelectProject: (projectId: string) => void;
  onSelectSection: (section: AppSection) => void;
  onAddProject: () => void;
  onEditProject: (projectId: string) => void;
  onMoveProject: (from: number, to: number) => void;
  /** Asks; the caller confirms before anything is removed. */
  onDeleteProject: (projectId: string) => void;
  /** Rejects with the reason the folder could not be shown; the sidebar reports it. */
  onRevealProject: (projectId: string) => Promise<void>;
  settingsShortcut: string;
}

export function Sidebar({
  projects,
  activeProjectId,
  activeSection,
  attentionCount,
  mode,
  platform,
  onSelectProject,
  onSelectSection,
  onAddProject,
  onEditProject,
  onMoveProject,
  onDeleteProject,
  onRevealProject,
  settingsShortcut,
}: SidebarProps) {
  const { t } = useI18n();
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);

  function revealProject(projectId: string) {
    setRevealError(null);
    onRevealProject(projectId).catch((cause: unknown) => setRevealError(errorMessage(cause)));
  }

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
          <span>{t("sidebar.localWorkspace")}</span>
        </div>
      </div>

      <nav className="primary-nav" aria-label={t("sidebar.primaryNav")}>
        {sections.map((section) => (
          <button
            className="nav-item"
            data-active={activeSection === section.id}
            data-testid={`nav-${section.id}`}
            key={section.id}
            type="button"
            aria-current={activeSection === section.id ? "page" : undefined}
            aria-label={
              section.id === "attention" && attentionCount > 0
                ? `${section.label}, ${t("attention.openCount", { count: attentionCount })}`
                : undefined
            }
            onClick={() => onSelectSection(section.id)}
          >
            <span className="nav-item__icon">
              <Icon name={section.icon} />
              {section.id === "attention" && attentionCount > 0 ? (
                <span className="nav-item__badge" aria-hidden="true">
                  {attentionCount}
                </span>
              ) : null}
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
        <span className="sidebar__section-actions">
          <button
            type="button"
            aria-label={t("sidebar.editProject")}
            title={t("sidebar.editProject")}
            disabled={
              projects.find((project) => project.id === activeProjectId)?.source !== "local"
            }
            onClick={() => onEditProject(activeProjectId)}
          >
            <Icon name="settings" size={14} />
          </button>
          <button
            type="button"
            data-testid="add-project"
            aria-label={t("sidebar.addProject")}
            title={t("sidebar.addProject")}
            onClick={onAddProject}
          >
            <Icon name="plus" size={15} />
          </button>
        </span>
      </div>

      <div className="project-list">
        {projects.map((project, index) => (
          <div className="project-row" key={project.id} data-menu-open={menuFor === project.id}>
            <button
              className="project-item"
              data-active={activeProjectId === project.id}
              type="button"
              onClick={() => onSelectProject(project.id)}
              onContextMenu={(event) => {
                if (project.source !== "local") return;
                event.preventDefault();
                setMenuFor(project.id);
              }}
            >
              <span
                className="project-item__mark"
                style={{ "--project-color": project.color } as React.CSSProperties}
              >
                {project.monogram}
              </span>
              <span className="project-item__copy">
                <strong>{project.name}</strong>
                <small>
                  {project.source === "preview"
                    ? t("sidebar.previewProject")
                    : t("sidebar.sessionCount", { count: project.sessions.length })}
                </small>
              </span>
              <Icon name="chevron" size={14} />
            </button>
            {project.source === "local" ? (
              <button
                className="project-item__options"
                type="button"
                aria-label={t("sidebar.projectOptions", { project: project.name })}
                title={t("sidebar.projectOptions", { project: project.name })}
                aria-haspopup="menu"
                aria-expanded={menuFor === project.id}
                onClick={() =>
                  setMenuFor((current) => (current === project.id ? null : project.id))
                }
              >
                ⋯
              </button>
            ) : null}
            {menuFor === project.id ? (
              <ProjectMenu
                project={project}
                platform={platform}
                canMoveUp={index > 0}
                canMoveDown={index < projects.length - 1}
                onClose={() => setMenuFor(null)}
                onEdit={() => onEditProject(project.id)}
                onReveal={() => revealProject(project.id)}
                onMoveUp={() => onMoveProject(index, index - 1)}
                onMoveDown={() => onMoveProject(index, index + 1)}
                onDelete={() => onDeleteProject(project.id)}
              />
            ) : null}
          </div>
        ))}
      </div>

      {revealError ? (
        <p className="sidebar__reveal-error" role="alert">
          <span>{t("sidebar.revealFolderFailed", { message: revealError })}</span>
          <button
            type="button"
            onClick={() => setRevealError(null)}
            aria-label={t("sidebar.dismissRevealError")}
          >
            <Icon name="x" size={12} />
          </button>
        </p>
      ) : null}

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
        aria-current={activeSection === "settings" ? "page" : undefined}
        onClick={() => onSelectSection("settings")}
      >
        <Icon name="settings" />
        <span>{t("sidebar.settings")}</span>
        <span className="sidebar-action__key">{settingsShortcut}</span>
      </button>
    </aside>
  );
}

/**
 * The per-project actions, as a small menu under the row. Explicit "move up / down" rather than a
 * drag: it works from the keyboard, and it sidesteps the HTML5 drag-and-drop the WKWebView is known
 * to drop `drop` events from.
 */
function ProjectMenu({
  project,
  platform,
  canMoveUp,
  canMoveDown,
  onClose,
  onEdit,
  onReveal,
  onMoveUp,
  onMoveDown,
  onDelete,
}: {
  project: Project;
  platform: DesktopPlatform;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onClose: () => void;
  onEdit: () => void;
  onReveal: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus(),
    );
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    const closeOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) onClose();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    document.addEventListener("mousedown", closeOutside);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", closeOnEscape, true);
      document.removeEventListener("mousedown", closeOutside);
    };
  }, [onClose]);

  const run = (action: () => void) => () => {
    onClose();
    action();
  };
  const revealLabel = t(`sidebar.revealFolder.${platform}`);

  return (
    <div
      className="project-menu"
      ref={menuRef}
      role="menu"
      aria-label={t("sidebar.projectMenuAria", { project: project.name })}
    >
      <button type="button" role="menuitem" onClick={run(onEdit)}>
        <Icon name="settings" size={14} />
        <span>{t("sidebar.editProjectItem")}</span>
      </button>
      <button type="button" role="menuitem" onClick={run(onReveal)} title={project.path}>
        <Icon name="folder" size={14} />
        <span>{revealLabel}</span>
      </button>
      <button type="button" role="menuitem" disabled={!canMoveUp} onClick={run(onMoveUp)}>
        <Icon name="chevron" size={14} />
        <span>{t("sidebar.moveProjectUp")}</span>
      </button>
      <button type="button" role="menuitem" disabled={!canMoveDown} onClick={run(onMoveDown)}>
        <Icon name="chevron" size={14} />
        <span>{t("sidebar.moveProjectDown")}</span>
      </button>
      <button type="button" role="menuitem" data-tone="danger" onClick={run(onDelete)}>
        <Icon name="x" size={14} />
        <span>{t("sidebar.deleteProject")}</span>
      </button>
    </div>
  );
}
