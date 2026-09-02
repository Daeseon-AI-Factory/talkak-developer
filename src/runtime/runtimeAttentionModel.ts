import type { DevSession, Project, TerminalRuntimeFault } from "../domain";

export type RuntimeAttentionEvent =
  | { kind: "exited"; exitCode: number | null }
  | { kind: "error"; fault: TerminalRuntimeFault | null }
  /** The agent record shows a finished reply after the last prompt; the PTY is still live. */
  | { kind: "turn-complete"; lastTool: string | null }
  /** The agent record shows a pending question or approval; the PTY is still live. */
  | { kind: "needs-input"; lastTool: string | null };

export type RuntimeAttentionKind = RuntimeAttentionEvent["kind"];

export interface RuntimeAttentionNotice {
  source: "local-pty";
  id: string;
  projectId: string;
  sessionId: string;
  observedAt: string;
  event: RuntimeAttentionEvent;
}

/** Kinds that come from the agent's own record rather than the PTY process. */
export const AGENT_RECORD_KINDS: readonly RuntimeAttentionKind[] = ["turn-complete", "needs-input"];

export function isAgentRecordNotice(notice: RuntimeAttentionNotice): boolean {
  return AGENT_RECORD_KINDS.includes(notice.event.kind);
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

        const found = runtimeAttentionEvent(session);
        if (!found) return [];
        const run = status.runId === null ? "unknown" : String(status.runId);
        return [
          {
            source: "local-pty" as const,
            id: `runtime:${session.id}:${run}:${found.event.kind}`,
            projectId: project.id,
            sessionId: session.id,
            observedAt: found.observedAt,
            event: found.event,
          },
        ];
      }),
    )
    .sort(compareRuntimeNotices);
}

/**
 * Display order across kinds. Failures first, then an agent that cannot continue without the user,
 * then processes that ended, then replies waiting to be read.
 */
const KIND_ORDER: Record<RuntimeAttentionKind, number> = {
  error: 0,
  "needs-input": 1,
  exited: 2,
  "turn-complete": 3,
};

export function runtimeNoticeRank(kind: RuntimeAttentionKind): number {
  return KIND_ORDER[kind];
}

function runtimeAttentionEvent(
  session: DevSession,
): { event: RuntimeAttentionEvent; observedAt: string } | null {
  const status = session.runtimeStatus;
  if (!status) return null;
  if (status.fault || status.phase === "error") {
    return { event: { kind: "error", fault: status.fault }, observedAt: status.observedAt };
  }
  if (status.phase === "exited" && status.termination !== "requested-stop") {
    return { event: { kind: "exited", exitCode: status.exitCode }, observedAt: status.observedAt };
  }
  // The record only speaks for a live process; applyAgentActivity already enforces that, and a
  // stale reading on a dead PTY is dropped by applyRuntimeObservation. Guard again anyway: the
  // notice must never outlive the process it describes.
  if (status.phase !== "running" && status.phase !== "stopping") return null;
  const activity = session.agentActivity;
  if (!activity) return null;
  const observedAt = activity.at ?? status.observedAt;
  if (activity.state === "done") {
    return { event: { kind: "turn-complete", lastTool: activity.lastTool }, observedAt };
  }
  if (activity.state === "needs-input") {
    return { event: { kind: "needs-input", lastTool: activity.lastTool }, observedAt };
  }
  return null;
}

function compareRuntimeNotices(
  left: RuntimeAttentionNotice,
  right: RuntimeAttentionNotice,
): number {
  const priority = KIND_ORDER[left.event.kind] - KIND_ORDER[right.event.kind];
  if (priority !== 0) return priority;
  const leftTime = Date.parse(left.observedAt);
  const rightTime = Date.parse(right.observedAt);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  return left.id.localeCompare(right.id);
}
