import { useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "../domain";
import { useI18n } from "../i18n";
import { runtimeLabel } from "../workspaceModel";
import { Icon } from "./Icon";

interface CommandPaletteProps {
  open: boolean;
  projects: readonly Project[];
  onClose: () => void;
  onOpenSession: (projectId: string, sessionId: string) => void;
  onOpenProject: (projectId: string) => void;
}

export function CommandPalette({
  open,
  projects,
  onClose,
  onOpenSession,
  onOpenProject,
}: CommandPaletteProps) {
  const { t, text } = useI18n();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [onClose, open]);

  const results = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return projects;
    return projects
      .map((project) => ({
        ...project,
        sessions: project.sessions.filter((session) =>
          [text(session.title), text(session.profile), session.branch, project.name]
            .join(" ")
            .toLocaleLowerCase()
            .includes(normalized),
        ),
      }))
      .filter(
        (project) =>
          project.name.toLocaleLowerCase().includes(normalized) || project.sessions.length > 0,
      );
  }, [projects, query, text]);

  if (!open) return null;

  const firstResult = results[0];
  const openFirstResult = () => {
    if (!firstResult) return;
    const firstSession = firstResult.sessions[0];
    if (firstSession) onOpenSession(firstResult.id, firstSession.id);
    else onOpenProject(firstResult.id);
    onClose();
  };

  return (
    <div
      className="command-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <dialog
        open
        className="command-palette"
        aria-label={t("command.title")}
        onCancel={(event) => {
          event.preventDefault();
          onClose();
        }}
      >
        <header className="command-palette__header">
          <Icon name="search" size={18} />
          <input
            ref={inputRef}
            value={query}
            placeholder={t("command.placeholder")}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              openFirstResult();
            }}
          />
          <kbd>ESC</kbd>
        </header>
        <div className="command-palette__results">
          {results.length > 0 ? (
            results.map((project) => (
              <div className="command-group" key={project.id}>
                <button
                  type="button"
                  onClick={() => {
                    onOpenProject(project.id);
                    onClose();
                  }}
                >
                  <span
                    className="command-group__mark"
                    style={{ "--project-color": project.color } as React.CSSProperties}
                  >
                    {project.monogram}
                  </span>
                  <span>
                    <strong>{project.name}</strong>
                    <small>{t("command.sessionCount", { count: project.sessions.length })}</small>
                  </span>
                </button>
                {project.sessions.map((session) => (
                  <button
                    className="command-session"
                    type="button"
                    key={session.id}
                    onClick={() => {
                      onOpenSession(project.id, session.id);
                      onClose();
                    }}
                  >
                    <Icon name="terminal" size={15} />
                    <span>
                      <strong>{text(session.title)}</strong>
                      <small>
                        {text(session.profile)} ·{" "}
                        {session.runtime.kind === "unconfigured"
                          ? t("runtime.unconfigured")
                          : text(runtimeLabel(session))}
                      </small>
                    </span>
                    <Icon name="chevron" size={13} />
                  </button>
                ))}
              </div>
            ))
          ) : (
            <div className="command-empty">{t("command.noResults")}</div>
          )}
        </div>
        <footer>{t("command.hint")}</footer>
      </dialog>
    </div>
  );
}
