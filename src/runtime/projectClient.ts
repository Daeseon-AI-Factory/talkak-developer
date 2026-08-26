import { invoke, isTauri } from "@tauri-apps/api/core";
import type { InvokeCommand } from "./sessionClient";

export type ProjectPathIssue = "empty" | "notAbsolute" | "notDirectory";

export interface ProjectPathValidation {
  valid: boolean;
  reason: ProjectPathIssue | null;
}

export type LaunchCommandIssue = "notFound";

export interface LaunchCommandValidation {
  valid: boolean;
  reason: LaunchCommandIssue | null;
}

export interface ProjectClient {
  available: () => boolean;
  validatePath: (path: string) => Promise<ProjectPathValidation>;
  validateCommand: (command: string) => Promise<LaunchCommandValidation>;
}

export function createProjectClient(
  invokeCommand: InvokeCommand,
  available: () => boolean,
): ProjectClient {
  return {
    available,
    validatePath: (path) => invokeCommand<ProjectPathValidation>("project_validate_path", { path }),
    validateCommand: (command) =>
      invokeCommand<LaunchCommandValidation>("project_validate_command", { command }),
  };
}

export const projectClient = createProjectClient(invoke, isTauri);
