import type { Project } from "./domain";

/** What the quit dialog must stop when the user chooses "close and stop everything". */
export interface SessionKill {
  sessionId: string;
  runId: number;
}

const ACTIVE_PHASES = new Set(["starting", "running", "stopping"]);

/**
 * Sessions whose child process is (or may still be) alive. Closing the window silently used to
 * leave these running headless in the broker — which is the point when chosen, and a zombie
 * factory when accidental; the quit dialog exists to make that a choice.
 */
export function runningSessionKills(projects: readonly Project[]): SessionKill[] {
  const kills: SessionKill[] = [];
  for (const project of projects) {
    for (const session of project.sessions) {
      const status = session.runtimeStatus;
      if (status && status.runId !== null && ACTIVE_PHASES.has(status.phase)) {
        kills.push({ sessionId: session.id, runId: status.runId });
      }
    }
  }
  return kills;
}
