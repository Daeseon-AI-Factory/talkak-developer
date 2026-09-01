import { useEffect, useState } from "react";
import type { TerminalRuntimePhase } from "../domain";
import { type AgentTranscript, type TranscriptScope, transcriptClient } from "./transcriptClient";

export type TranscriptState =
  | { kind: "unsupported" }
  | { kind: "loading" }
  | { kind: "absent" }
  | { kind: "failed"; message: string }
  | { kind: "loaded"; transcript: AgentTranscript };

/**
 * The agent transcript bound to one Talkak session, refreshed while the panel is open.
 *
 * Five states, not one list. "No record yet" and "the record could not be read" are different
 * facts, and this app has already shipped the wrong one twice — a refused clipboard that looked
 * like a successful copy, and a broker error that became an empty session list while twenty-two
 * shells were running. An empty array would have made the same mistake a third time.
 */
export function useAgentTranscript(
  scope: TranscriptScope | null,
  active: boolean,
  runtimePhase: TerminalRuntimePhase | null,
  refreshMs = 4000,
): { state: TranscriptState } {
  const sessionId = scope?.sessionId ?? null;
  const runId = scope?.runId ?? null;
  const projectPath = scope?.projectPath ?? null;
  const startedAt = scope?.startedAt ?? null;
  const agentCommand = scope?.agentCommand ?? null;
  const request: TranscriptScope | null =
    sessionId !== null && projectPath !== null && startedAt !== null
      ? { sessionId, runId, projectPath, startedAt, agentCommand }
      : null;
  const scopeKey = request
    ? JSON.stringify([sessionId, runId, projectPath, startedAt, agentCommand])
    : null;
  const [snapshot, setSnapshot] = useState<{
    scopeKey: string | null;
    state: TranscriptState;
  }>(() => ({
    scopeKey,
    state: transcriptInitialState(request),
  }));
  // Derive loading immediately when the selected session changes. Waiting for an effect would
  // paint the previous session's transcript for one frame.
  const state: TranscriptState =
    snapshot.scopeKey === scopeKey ? snapshot.state : transcriptInitialState(request);

  useEffect(() => {
    if (
      !active ||
      sessionId === null ||
      projectPath === null ||
      startedAt === null ||
      !transcriptClient.available()
    )
      return;
    const request: TranscriptScope = { sessionId, runId, projectPath, startedAt, agentCommand };
    const requestKey = JSON.stringify([sessionId, runId, projectPath, startedAt, agentCommand]);
    let cancelled = false;

    const load = async () => {
      try {
        const transcript = await transcriptClient.read(request, 800);
        if (cancelled) return;
        setSnapshot({
          scopeKey: requestKey,
          state: transcript ? { kind: "loaded", transcript } : { kind: "absent" },
        });
      } catch (cause: unknown) {
        if (cancelled) return;
        setSnapshot({
          scopeKey: requestKey,
          state: {
            kind: "failed",
            message: cause instanceof Error ? cause.message : String(cause),
          },
        });
      }
    };

    const stopRefresh = startTranscriptRefresh(
      load,
      transcriptPhaseIsLive(runtimePhase),
      refreshMs,
    );
    return () => {
      cancelled = true;
      stopRefresh();
    };
  }, [active, sessionId, runId, projectPath, startedAt, agentCommand, runtimePhase, refreshMs]);

  return { state };
}

function transcriptInitialState(scope: TranscriptScope | null): TranscriptState {
  if (!transcriptClient.available()) return { kind: "unsupported" };
  if (!scope) return { kind: "absent" };
  const cached = transcriptClient.peek(scope, 800);
  return cached ? { kind: "loaded", transcript: cached } : { kind: "loading" };
}

export function transcriptPhaseIsLive(phase: TerminalRuntimePhase | null): boolean {
  return phase === "running" || phase === "stopping";
}

/**
 * Read once immediately, then continue only while the runtime is live. The next read is scheduled
 * after the current one settles, so a large native read can never build an overlapping IPC queue.
 */
export function startTranscriptRefresh(
  load: () => Promise<void>,
  live: boolean,
  refreshMs: number,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = async () => {
    try {
      await load();
    } finally {
      if (!stopped && live) timer = setTimeout(() => void run(), refreshMs);
    }
  };

  void run().catch(() => {});
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
