import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
import type { Project } from "./domain";
import {
  type ProjectDraft,
  browserProjectStorage,
  createLocalProject,
  readStoredProjects,
  updateLocalProject,
  writeStoredProjects,
} from "./projectStore";

export interface ProjectSaveResult {
  project: Project;
  created: boolean;
  replacedPreviews: boolean;
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
}

export function useProjectRegistry(
  previewProjects: readonly Project[],
  initializeProjects: (projects: Project[]) => Project[] = (projects) => projects,
): ProjectRegistry {
  const [projects, setProjects] = useState<Project[]>(() => {
    const storage = browserProjectStorage();
    const stored = storage ? readStoredProjects(storage) : [];
    return initializeProjects(stored.length > 0 ? stored : [...previewProjects]);
  });
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const editingProject =
    projects.find((project) => project.id === editingProjectId && project.source === "local") ??
    null;

  useEffect(() => {
    if (!projects.some((project) => project.source === "local")) return;
    const storage = browserProjectStorage();
    if (!storage) return;
    try {
      writeStoredProjects(storage, projects);
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

  return {
    projects,
    setProjects,
    editorOpen,
    editingProject,
    openProjectCreator,
    openProjectEditor,
    closeProjectEditor,
    saveProject,
  };
}
