import type { Project } from "./domain";
import { sessionActivity } from "./pageActivity";

/**
 * What deleting a project costs, in the dialog's terms.
 *
 * Deleting a project removes its settings and page layout from this device and nothing else:
 * every session stays in the broker, and the running ones surface under "Left behind" on the
 * Sessions screen. So the dialog says how many sessions are about to lose their home and how
 * many of those are still working — not what dies, because nothing does.
 */
export interface ProjectDeleteImpact {
  sessions: number;
  running: number;
}

export function projectDeleteImpact(project: Pick<Project, "sessions">): ProjectDeleteImpact {
  let running = 0;
  for (const session of project.sessions) {
    if (sessionActivity(session) === "running") running += 1;
  }
  return { sessions: project.sessions.length, running };
}

/** The project to land on once `projectId` is gone: the next one down, else the one above. */
export function neighbourProjectId(projects: readonly Project[], projectId: string): string | null {
  const index = projects.findIndex((project) => project.id === projectId);
  if (index < 0) return null;
  return projects[index + 1]?.id ?? projects[index - 1]?.id ?? null;
}
