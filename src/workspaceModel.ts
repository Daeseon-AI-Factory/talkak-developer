import type { DevSession, Project } from "./domain";
import type { WorkspacePage } from "./layoutModel";
import type { LocalizedText } from "./localizedText";

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

export function runtimeLabel(session: DevSession): LocalizedText {
  if (session.runtime.kind === "unconfigured") {
    return session.runtime.label;
  }
  if (session.runtime.kind === "wsl") {
    return `WSL · ${session.runtime.distribution}`;
  }
  if (session.runtime.kind === "local") return session.runtime.label;
  return session.runtime.os === "macos" ? "macOS" : "Windows";
}

export function firstSession(project: Project): DevSession | null {
  return project.sessions[0] ?? null;
}

export function nextGeneratedPageTitle(pages: readonly WorkspacePage[]): {
  kind: "page-title";
  index: number;
} {
  let highestIndex = pages.length;
  for (const page of pages) {
    if (typeof page.title !== "string" && page.title.kind === "page-title") {
      highestIndex = Math.max(highestIndex, page.title.index);
    }
  }
  return { kind: "page-title", index: highestIndex + 1 };
}
