import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import type { AgentActivity, Project } from "../domain";
import type { TranscriptScope } from "./transcriptClient";

/**
 * Per-session agent activity, read from the record the native side already tails.
 *
 * The transcript panel refreshes only while it is open; a pane's status has to move whether or not
 * anyone is looking at the Inspector. So every attached live session gets its own small poll of
 * `agent_activity` — a projection of the cached bound transcript, one stat and the appended lines
 * per call — and the answer is folded into the session record the whole UI already reads.
 *
 * No hook is installed into the agent, no global config is edited: the record on disk is the only
 * source, whichever agent wrote it.
 */
export interface AgentActivityReport {
  activity: AgentActivity;
  revision: number;
}

export type AgentActivityScope = TranscriptScope;

export interface AgentActivityClient {
  available: () => boolean;
  /** The activity of the record bound to this session, or null when no record is bound yet. */
  read: (scope: AgentActivityScope) => Promise<AgentActivityReport | null>;
}

export const AGENT_ACTIVITY_INTERVAL_MS = 1000;

export function createAgentActivityClient(
  invokeCommand: <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
  available: () => boolean,
): AgentActivityClient {
  return {
    available,
    read: (scope) => invokeCommand<AgentActivityReport | null>("agent_activity", { ...scope }),
  };
}

export const agentActivityClient = createAgentActivityClient(invoke, isTauri);

export interface AgentActivityTarget {
  projectId: string;
  scope: AgentActivityScope;
}

/** Every session whose PTY is live in a local project — the ones whose record can still move. */
export function agentActivityTargets(projects: readonly Project[]): AgentActivityTarget[] {
  return projects
    .filter((project) => project.source === "local")
    .flatMap((project) =>
      project.sessions
        .filter((session) => {
          const phase = session.runtimeStatus?.phase;
          return phase === "running" || phase === "stopping";
        })
        .map((session) => ({
          projectId: project.id,
          scope: {
            sessionId: session.id,
            runId: session.runtimeStatus?.runId ?? null,
            projectPath: project.path,
            startedAt: session.startedAt,
            agentCommand: session.launchProfile.command,
          },
        })),
    );
}

/**
 * Poll one target until stopped. The next read is scheduled only after the current one settles, so
 * a slow native call can never build an overlapping IPC queue. A failed read is retried on the next
 * tick rather than ending the loop: a transient broker hiccup must not freeze a status forever.
 */
export function startAgentActivityPolling(
  read: () => Promise<void>,
  intervalMs: number,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = async () => {
    try {
      await read();
    } catch {
      // Retried on the next tick.
    } finally {
      if (!stopped) timer = setTimeout(() => void run(), intervalMs);
    }
  };

  void run();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

export type AgentActivityListener = (
  sessionId: string,
  report: AgentActivityReport,
  observedAt: string,
) => void;

/**
 * Keep one poll loop per live session for as long as it stays live. The loops are keyed on the
 * exact scope set, so a status update — which re-renders the caller every second — does not tear
 * them down and start them over.
 */
export function useAgentActivityPolling(
  projects: readonly Project[],
  onReport: AgentActivityListener,
  intervalMs = AGENT_ACTIVITY_INTERVAL_MS,
  client: AgentActivityClient = agentActivityClient,
): void {
  const targetsKey = JSON.stringify(agentActivityTargets(projects));
  const onReportRef = useRef(onReport);
  onReportRef.current = onReport;

  useEffect(() => {
    if (!client.available()) return;
    const targets = JSON.parse(targetsKey) as AgentActivityTarget[];
    if (targets.length === 0) return;
    const stops = targets.map(({ scope }) =>
      startAgentActivityPolling(async () => {
        const report = await client.read(scope);
        if (report) onReportRef.current(scope.sessionId, report, new Date().toISOString());
      }, intervalMs),
    );
    return () => {
      for (const stop of stops) stop();
    };
  }, [client, intervalMs, targetsKey]);
}

/** Minutes since the record last moved, or null when there is no usable time. */
export function agentRecordIdleMinutes(
  activity: AgentActivity | null,
  nowMs: number,
): number | null {
  if (!activity?.at) return null;
  const at = Date.parse(activity.at);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.floor((nowMs - at) / 60_000));
}

export const AGENT_RECORD_STALE_MINUTES = 10;

/**
 * "The agent may be gone": the PTY is alive, the record says the agent is mid-turn, and nothing has
 * been appended for a long time. Without a process probe this is a hint, not a verdict — a long
 * tool call looks the same — so callers must label it as one. A finished turn or a pending
 * question can legitimately sit for hours and is never flagged.
 */
export function agentRecordLooksStale(
  activity: AgentActivity | null,
  nowMs: number,
  staleMinutes = AGENT_RECORD_STALE_MINUTES,
): boolean {
  if (!activity || (activity.state !== "thinking" && activity.state !== "working")) return false;
  const idle = agentRecordIdleMinutes(activity, nowMs);
  return idle !== null && idle >= staleMinutes;
}
