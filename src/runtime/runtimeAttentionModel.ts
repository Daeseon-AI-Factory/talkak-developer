import type { Project, TerminalRuntimeFault } from "../domain";

export type RuntimeAttentionEvent =
  | { kind: "exited"; exitCode: number | null }
  | { kind: "error"; fault: TerminalRuntimeFault | null };

export interface RuntimeAttentionNotice {
  source: "local-pty";
  id: string;
  projectId: string;
  sessionId: string;
  observedAt: string;
  event: RuntimeAttentionEvent;
}

export function runtimeAttentionNoticeKey(notice: RuntimeAttentionNotice): string {
  return `${notice.id}@${notice.observedAt}`;
}

export function runtimeAttentionNotices(projects: readonly Project[]): RuntimeAttentionNotice[] {
  return projects
    .filter((project) => project.source === "local")
    .flatMap((project) =>
      project.sessions.flatMap((session) => {
        const status = session.runtimeStatus;
        if (!status) return [];

        const event = runtimeAttentionEvent(status);
        if (!event) return [];
        const run = status.runId === null ? "unknown" : String(status.runId);
        return [
          {
            source: "local-pty" as const,
            id: `runtime:${session.id}:${run}:${event.kind}`,
            projectId: project.id,
            sessionId: session.id,
            observedAt: status.observedAt,
            event,
          },
        ];
      }),
    )
    .sort(compareRuntimeNotices);
}

function runtimeAttentionEvent(
  status: NonNullable<Project["sessions"][number]["runtimeStatus"]>,
): RuntimeAttentionEvent | null {
  if (status.fault || status.phase === "error") {
    return { kind: "error", fault: status.fault };
  }
  if (status.phase === "exited" && status.termination !== "requested-stop") {
    return { kind: "exited", exitCode: status.exitCode };
  }
  return null;
}

function compareRuntimeNotices(
  left: RuntimeAttentionNotice,
  right: RuntimeAttentionNotice,
): number {
  const priority = Number(left.event.kind === "exited") - Number(right.event.kind === "exited");
  if (priority !== 0) return priority;
  const leftTime = Date.parse(left.observedAt);
  const rightTime = Date.parse(right.observedAt);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  return left.id.localeCompare(right.id);
}
