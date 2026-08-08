import type { DevSession, Project } from "./domain";

export interface SessionCounts {
  working: number;
  needsInput: number;
  ready: number;
}

export function countSessions(sessions: readonly DevSession[]): SessionCounts {
  return sessions.reduce<SessionCounts>(
    (counts, session) => {
      if (session.state === "working") counts.working += 1;
      if (session.state === "needs-input") counts.needsInput += 1;
      if (session.state === "ready") counts.ready += 1;
      return counts;
    },
    { working: 0, needsInput: 0, ready: 0 },
  );
}

export function runtimeLabel(session: DevSession): string {
  if (session.runtime.kind === "unconfigured") {
    return session.runtime.label;
  }
  if (session.runtime.kind === "wsl") {
    return `WSL · ${session.runtime.distribution}`;
  }
  return session.runtime.os === "macos" ? "macOS" : "Windows";
}

export function firstSession(project: Project): DevSession | null {
  return project.sessions[0] ?? null;
}
