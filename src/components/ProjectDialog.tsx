import { type FormEvent, useEffect, useRef, useState } from "react";
import type { Project } from "../domain";
import { useI18n } from "../i18n";
import { type ProjectDraft, parseLaunchArguments } from "../projectStore";
import { directoryPicker } from "../runtime/directoryPicker";
import { type ProjectPathIssue, projectClient } from "../runtime/projectClient";
import { errorMessage } from "../runtime/sessionClient";
import { Icon } from "./Icon";

interface ProjectDialogProps {
  open: boolean;
  project: Project | null;
  onClose: () => void;
  onSave: (draft: ProjectDraft) => void;
}

export function ProjectDialog({ open, project, onClose, onSave }: ProjectDialogProps) {
  const { t } = useI18n();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [path, setPath] = useState("");
  const [profileLabel, setProfileLabel] = useState("");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const desktopAvailable = projectClient.available();

  useEffect(() => {
    if (!open) return;
    setName(project?.name ?? "");
    setDescription(project?.description ?? "");
    setPath(project?.path ?? "");
    setProfileLabel(project?.launchProfile.label ?? "");
    setCommand(project?.launchProfile.command ?? "");
    setArgsText(project?.launchProfile.args.join("\n") ?? "");
    setBusy(false);
    setError(null);
    const frame = requestAnimationFrame(() => nameRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, project]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [busy, onClose, open]);

  if (!open) return null;

  async function chooseDirectory() {
    setBusy(true);
    setError(null);
    try {
      const selected = await directoryPicker.pick(path, t("projectDialog.chooseTitle"));
      if (selected) setPath(selected);
    } catch (cause: unknown) {
      setError(`${t("projectDialog.pickFailed")} ${errorMessage(cause)}`);
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextName = name.trim();
    const nextPath = path.trim();
    if (!nextName || !nextPath) {
      setError(t("projectDialog.required"));
      return;
    }

    setBusy(true);
    setError(null);
    try {
      if (desktopAvailable) {
        const validation = await projectClient.validatePath(nextPath);
        if (!validation.valid) {
          setError(pathIssueMessage(validation.reason, t));
          return;
        }
      }
      const normalizedCommand = command.trim() || null;
      onSave({
        name: nextName,
        description: description.trim(),
        path: nextPath,
        launchProfile: {
          label: profileLabel.trim(),
          command: normalizedCommand,
          args: normalizedCommand ? parseLaunchArguments(argsText) : [],
        },
      });
    } catch (cause: unknown) {
      setError(`${t("projectDialog.validationFailed")} ${errorMessage(cause)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="project-dialog-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <dialog open aria-modal="true" className="project-dialog" aria-labelledby="project-title">
        <form onSubmit={(event) => void submit(event)}>
          <header className="project-dialog__header">
            <div>
              <span>{t("projectDialog.eyebrow")}</span>
              <h1 id="project-title">
                {project ? t("projectDialog.editTitle") : t("projectDialog.addTitle")}
              </h1>
              <p>{t("projectDialog.description")}</p>
            </div>
            <button
              type="button"
              aria-label={t("projectDialog.close")}
              disabled={busy}
              onClick={onClose}
            >
              <Icon name="x" size={17} />
            </button>
          </header>

          <div className="project-dialog__body">
            <section className="project-dialog__section">
              <div className="project-dialog__grid">
                <label>
                  <span>{t("projectDialog.name")}</span>
                  <input
                    ref={nameRef}
                    data-testid="project-name"
                    value={name}
                    onChange={(event) => setName(event.currentTarget.value)}
                    placeholder={t("projectDialog.namePlaceholder")}
                    disabled={busy}
                  />
                </label>
                <label>
                  <span>{t("projectDialog.projectDescription")}</span>
                  <input
                    value={description}
                    onChange={(event) => setDescription(event.currentTarget.value)}
                    placeholder={t("projectDialog.descriptionPlaceholder")}
                    disabled={busy}
                  />
                </label>
              </div>

              <label>
                <span>{t("projectDialog.path")}</span>
                <span className="project-dialog__path-field">
                  <input
                    data-testid="project-path"
                    value={path}
                    onChange={(event) => setPath(event.currentTarget.value)}
                    placeholder={t("projectDialog.pathPlaceholder")}
                    disabled={busy}
                  />
                  <button
                    type="button"
                    disabled={busy || !directoryPicker.available()}
                    onClick={() => void chooseDirectory()}
                  >
                    <Icon name="folder" size={15} />
                    {t("projectDialog.choose")}
                  </button>
                </span>
              </label>
              {!desktopAvailable ? (
                <p className="project-dialog__notice">{t("projectDialog.browserNotice")}</p>
              ) : null}
            </section>

            <section className="project-dialog__section">
              <div className="project-dialog__section-heading">
                <div>
                  <span>{t("projectDialog.profileEyebrow")}</span>
                  <h2>{t("projectDialog.profileTitle")}</h2>
                </div>
                <small>{t("projectDialog.profileOptional")}</small>
              </div>
              <label>
                <span>{t("projectDialog.profileName")}</span>
                <input
                  value={profileLabel}
                  onChange={(event) => setProfileLabel(event.currentTarget.value)}
                  placeholder={t("projectDialog.profilePlaceholder")}
                  disabled={busy}
                />
              </label>
              <label>
                <span>{t("projectDialog.command")}</span>
                <input
                  value={command}
                  onChange={(event) => setCommand(event.currentTarget.value)}
                  placeholder={t("projectDialog.commandPlaceholder")}
                  disabled={busy}
                  spellCheck={false}
                />
                <small>{t("projectDialog.commandHint")}</small>
              </label>
              <label>
                <span>{t("projectDialog.arguments")}</span>
                <textarea
                  value={argsText}
                  onChange={(event) => setArgsText(event.currentTarget.value)}
                  placeholder={t("projectDialog.argumentsPlaceholder")}
                  disabled={busy || !command.trim()}
                  rows={3}
                  spellCheck={false}
                />
                <small>{t("projectDialog.argumentsHint")}</small>
              </label>
            </section>

            {error ? (
              <p className="project-dialog__error" role="alert">
                {error}
              </p>
            ) : null}
          </div>

          <footer className="project-dialog__footer">
            <p>{t("projectDialog.localOnly")}</p>
            <div>
              <button className="button" type="button" disabled={busy} onClick={onClose}>
                {t("projectDialog.cancel")}
              </button>
              <button
                className="button button--primary"
                type="submit"
                data-testid="save-project"
                disabled={busy}
              >
                {busy
                  ? t("projectDialog.saving")
                  : project
                    ? t("projectDialog.update")
                    : t("projectDialog.add")}
              </button>
            </div>
          </footer>
        </form>
      </dialog>
    </div>
  );
}

function pathIssueMessage(
  issue: ProjectPathIssue | null,
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (issue === "empty") return t("projectDialog.pathEmpty");
  if (issue === "notAbsolute") return t("projectDialog.pathNotAbsolute");
  if (issue === "notDirectory") return t("projectDialog.pathNotDirectory");
  return t("projectDialog.validationFailed");
}
