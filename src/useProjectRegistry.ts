import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react";
import type { Project } from "./domain";
import {
  type ProjectDraft,
  browserProjectStorage,
  createLocalProject,
  moveProject as moveProjectInList,
  readStoredProjects,
  removeLocalProject,
  updateLocalProject,
  writeStoredProjects,
} from "./projectStore";

export interface ProjectSaveResult {
  project: Project;
  created: boolean;
  replacedPreviews: boolean;
}

export interface ProjectRemoveResult {
  removed: boolean;
  /** The example projects came back because the last real one went. */
  restoredPreviews: boolean;
}

interface ProjectRegistry {
  projects: Project[];
  setProjects: Dispatch<SetStateAction<Project[]>>;
  editorOpen: boolean;
  editingProject: Project | null;
  openProjectCreator: () => void;
  openProjectEditor: (projectId: string) => void;
  closeProjectEditor: () => void;
  saveProject: (draft: ProjectDraft) => ProjectSaveResult;
  /** Drop a local project from the list and from storage. Its sessions keep running in the broker. */
  removeProject: (projectId: string) => ProjectRemoveResult;
  /** Reorder the sidebar; the new order is what gets stored. */
  moveProject: (from: number, to: number) => void;
}

export function useProjectRegistry(
  previewProjects: readonly Project[],
  initializeProjects: (projects: Project[]) => Project[] = (projects) => projects,
): ProjectRegistry {
  const [initialStored] = useState(() => {
    const storage = browserProjectStorage();
    return storage ? readStoredProjects(storage) : [];
  });
  const [projects, setProjects] = useState<Project[]>(() =>
    initializeProjects(initialStored.length > 0 ? initialStored : [...previewProjects]),
  );
  // Once a local project has ever been stored, every change is written — including the change to
  // none. Writing only while a local project exists meant deleting the last one was never
  // persisted, and it came back on the next launch.
  const persisted = useRef(initialStored.length > 0);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const editingProject =
    projects.find((project) => project.id === editingProjectId && project.source === "local") ??
    null;

  useEffect(() => {
    const hasLocal = projects.some((project) => project.source === "local");
    if (!hasLocal && !persisted.current) return;
    const storage = browserProjectStorage();
    if (!storage) return;
    try {
      writeStoredProjects(storage, projects);
      persisted.current = true;
    } catch {
      // Project work remains available for this run when browser storage is unavailable.
    }
  }, [projects]);

  function openProjectCreator() {
    setEditingProjectId(null);
    setEditorOpen(true);
  }

  function openProjectEditor(projectId: string) {
    const project = projects.find(
      (candidate) => candidate.id === projectId && candidate.source === "local",
    );
    if (!project) return;
    setEditingProjectId(project.id);
    setEditorOpen(true);
  }

  function closeProjectEditor() {
    setEditorOpen(false);
    setEditingProjectId(null);
  }

  function saveProject(draft: ProjectDraft): ProjectSaveResult {
    if (editingProject) {
      const project = updateLocalProject(editingProject, draft);
      setProjects((current) =>
        current.map((candidate) => (candidate.id === project.id ? project : candidate)),
      );
      closeProjectEditor();
      return { project, created: false, replacedPreviews: false };
    }

    const project = createLocalProject(draft);
    const replacedPreviews = !projects.some((candidate) => candidate.source === "local");
    setProjects((current) =>
      current.some((candidate) => candidate.source === "local") ? [...current, project] : [project],
    );
    closeProjectEditor();
    return { project, created: true, replacedPreviews };
  }

  function removeProject(projectId: string): ProjectRemoveResult {
    const next = removeLocalProject(projects, projectId);
    if (next.length === projects.length) return { removed: false, restoredPreviews: false };
    if (editingProjectId === projectId) closeProjectEditor();
    // The workspace needs at least one project to stand on; with the last real one gone, the
    // examples come back — the same state as a fresh install, which is what an empty store means.
    const restoredPreviews = next.length === 0;
    setProjects(restoredPreviews ? initializeProjects([...previewProjects]) : next);
    return { removed: true, restoredPreviews };
  }

  function moveProject(from: number, to: number) {
    setProjects((current) => moveProjectInList(current, from, to));
  }

  return {
    projects,
    setProjects,
    editorOpen,
    editingProject,
    openProjectCreator,
    openProjectEditor,
    closeProjectEditor,
    saveProject,
    removeProject,
    moveProject,
  };
}
