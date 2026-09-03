import { useState } from "react";
import type { DevSession, Project, TerminalRuntimeObservation } from "./domain";
import { openerClient } from "./runtime/openerClient";
import { typeIntoSession } from "./runtime/sessionDispatch";

/**
 * The project-scoped side effects that don't belong to layout or session state: confirming a
 * delete, revealing a project's folder, typing a command-palette line into the active session,
 * and jumping to the Nth project by number. Pulled out of App.tsx so that shell keeps its own
 * shape readable.
 */
export interface ProjectActions {
  /** The project a delete confirmation is pending for, or null when none is open. */
  deletingProject: Project | null;
  requestDeleteProject: (projectId: string) => void;
  cancelDeleteProject: () => void;
  confirmDeleteProject: (projectId: string) => void;
  /** Show `projectId`'s folder in Finder/Explorer. Rejects with the reason on failure. */
  revealProject: (projectId: string) => Promise<void>;
  /** Type `text` into the active session's PTY, as the command palette's `>` line asks. */
  dispatchToActiveSession: (text: string) => void;
  /** Select the project at `index` (0-based); does nothing past the end of the list. */
  focusProject: (index: number) => void;
}

export function useProjectActions({
  projects,
  activeSession,
  removeProject,
  updateRuntimeObservation,
  selectProject,
}: {
  projects: readonly Project[];
  activeSession: DevSession | null;
  removeProject: (projectId: string) => void;
  updateRuntimeObservation: (sessionId: string, observation: TerminalRuntimeObservation) => void;
  selectProject: (projectId: string) => void;
}): ProjectActions {
  const [projectToDelete, setProjectToDelete] = useState<string | null>(null);
  const deletingProject = projects.find((project) => project.id === projectToDelete) ?? null;

  function confirmDeleteProject(projectId: string) {
    removeProject(projectId);
    setProjectToDelete(null);
  }

  function revealProject(projectId: string): Promise<void> {
    const project = projects.find((candidate) => candidate.id === projectId);
    if (!project) return Promise.resolve();
    return openerClient.revealPath(project.path);
  }

  function dispatchToActiveSession(text: string) {
    if (!activeSession) return;
    void typeIntoSession(activeSession, text, updateRuntimeObservation);
  }

  function focusProject(index: number) {
    const project = projects[index];
    if (project) selectProject(project.id);
  }

  return {
    deletingProject,
    requestDeleteProject: setProjectToDelete,
    cancelDeleteProject: () => setProjectToDelete(null),
    confirmDeleteProject,
    revealProject,
    dispatchToActiveSession,
    focusProject,
  };
}
