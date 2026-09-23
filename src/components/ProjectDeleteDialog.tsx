import type { Project } from "../domain";
import { useI18n } from "../i18n";
import { projectDeleteImpact } from "../projectDelete";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * The question before a project goes. Deleting removes its settings and layout from this device;
 * its sessions keep running in the broker and show up under "Left behind" — the dialog says so,
 * with the counts, instead of implying anything is stopped.
 */
export function ProjectDeleteDialog({
  project,
  onCancel,
  onConfirm,
}: {
  project: Project | null;
  onCancel: () => void;
  onConfirm: (projectId: string) => void;
}) {
  const { t } = useI18n();
  const impact = project ? projectDeleteImpact(project) : { sessions: 0, running: 0 };
  return (
    <ConfirmDialog
      open={project !== null}
      title={t("projects.deleteConfirmTitle", { project: project?.name ?? "" })}
      body={
        impact.running > 0
          ? t("projects.deleteConfirmRunning", {
              sessions: impact.sessions,
              running: impact.running,
            })
          : t("projects.deleteConfirmIdle", { sessions: impact.sessions })
      }
      cancelLabel={t("projects.deleteConfirmCancel")}
      onCancel={onCancel}
      actions={[
        {
          label: t("projects.deleteConfirmAccept"),
          detail: t("projects.deleteConfirmAcceptDetail"),
          tone: "danger",
          onSelect: () => {
            if (project) onConfirm(project.id);
          },
        },
      ]}
    />
  );
}
