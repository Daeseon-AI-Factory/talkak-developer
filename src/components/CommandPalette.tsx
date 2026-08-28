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
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setSelectedIndex(0);
    }
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

  const entries = useMemo(
    () =>
      results.flatMap((project) => [
        { kind: "project" as const, project },
        ...project.sessions.map((session) => ({ kind: "session" as const, project, session })),
      ]),
    [results],
  );

  useEffect(() => {
    if (entries.length === 0) {
      setSelectedIndex(0);
      return;
    }
    setSelectedIndex((current) => Math.min(current, entries.length - 1));
  }, [entries.length]);

  useEffect(() => {
    resultsRef.current
      ?.querySelector<HTMLElement>(`[data-command-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!open) return null;

  const openSelectedEntry = () => {
    const entry = entries[selectedIndex];
    if (!entry) return;
    if (entry.kind === "session") onOpenSession(entry.project.id, entry.session.id);
    else onOpenProject(entry.project.id);
    onClose();
  };

  const selectOffset = (offset: number) => {
    if (entries.length === 0) return;
    setSelectedIndex((current) => (current + offset + entries.length) % entries.length);
  };

  const projectEntryIndex = (projectId: string) =>
    entries.findIndex((entry) => entry.kind === "project" && entry.project.id === projectId);
  const sessionEntryIndex = (sessionId: string) =>
    entries.findIndex((entry) => entry.kind === "session" && entry.session.id === sessionId);

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
            onChange={(event) => {
              setQuery(event.target.value);
              // Typing aims at a new set of results, so the highlight belongs back at the top.
              setSelectedIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                selectOffset(event.key === "ArrowDown" ? 1 : -1);
              } else if (event.key === "Home" || event.key === "End") {
                event.preventDefault();
                setSelectedIndex(event.key === "Home" ? 0 : Math.max(0, entries.length - 1));
              } else if (event.key === "Enter") {
                event.preventDefault();
                openSelectedEntry();
              }
            }}
            aria-activedescendant={
              entries.length > 0 ? `command-entry-${selectedIndex}` : undefined
            }
            aria-controls="command-palette-results"
          />
          <kbd>ESC</kbd>
        </header>
        <div
          className="command-palette__results"
          id="command-palette-results"
          ref={resultsRef}
          // biome-ignore lint/a11y/useSemanticElements: a <select> cannot hold the project monogram,
          // name and session count each row shows, nor keep focus in the search field.
          role="listbox"
          // Focus stays in the input and moves the highlight through aria-activedescendant; the
          // list itself is only a programmatic focus target.
          tabIndex={-1}
        >
          {results.length > 0 ? (
            results.map((project) => (
              <div className="command-group" key={project.id}>
                <button
                  type="button"
                  id={`command-entry-${projectEntryIndex(project.id)}`}
                  // biome-ignore lint/a11y/useSemanticElements: an <option> cannot render the row this shows;
                  // the listbox keeps focus in the search field instead.
                  role="option"
                  aria-selected={selectedIndex === projectEntryIndex(project.id)}
                  data-active={selectedIndex === projectEntryIndex(project.id)}
                  data-command-index={projectEntryIndex(project.id)}
                  onMouseEnter={() => setSelectedIndex(projectEntryIndex(project.id))}
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
                    id={`command-entry-${sessionEntryIndex(session.id)}`}
                    // biome-ignore lint/a11y/useSemanticElements: an <option> cannot render the row this shows;
                    // the listbox keeps focus in the search field instead.
                    role="option"
                    aria-selected={selectedIndex === sessionEntryIndex(session.id)}
                    data-active={selectedIndex === sessionEntryIndex(session.id)}
                    data-command-index={sessionEntryIndex(session.id)}
                    onMouseEnter={() => setSelectedIndex(sessionEntryIndex(session.id))}
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
