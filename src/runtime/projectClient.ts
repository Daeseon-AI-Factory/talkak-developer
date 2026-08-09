import { invoke, isTauri } from "@tauri-apps/api/core";
import type { InvokeCommand } from "./sessionClient";

export type ProjectPathIssue = "empty" | "notAbsolute" | "notDirectory";

export interface ProjectPathValidation {
  valid: boolean;
  reason: ProjectPathIssue | null;
}

export interface ProjectClient {
  available: () => boolean;
  validatePath: (path: string) => Promise<ProjectPathValidation>;
}

export function createProjectClient(
  invokeCommand: InvokeCommand,
  available: () => boolean,
): ProjectClient {
  return {
    available,
    validatePath: (path) => invokeCommand<ProjectPathValidation>("project_validate_path", { path }),
  };
}

export const projectClient = createProjectClient(invoke, isTauri);
