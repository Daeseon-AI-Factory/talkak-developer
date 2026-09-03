import { useEffect, useRef, useState } from "react";
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

  // The state the last read for this scope produced, read by the next poll without waiting for a
  // render: it carries the revision to send, and the object to keep when nothing changed.
  const latestRef = useRef<{ scopeKey: string | null; state: TranscriptState }>(snapshot);
  latestRef.current = { scopeKey, state };

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
        const previous = latestRef.current.scopeKey === requestKey ? latestRef.current.state : null;
        const known = previous?.kind === "loaded" ? previous.transcript : null;
        const transcript = await transcriptClient.read(request, 800, known?.revision);
        if (cancelled) return;
        const next = nextTranscriptState(previous, transcript);
        // The same object back means the record did not change: leave React's state alone so the
        // panel does not re-render for a poll that found nothing.
        if (next === previous) return;
        setSnapshot({ scopeKey: requestKey, state: next });
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

/**
 * The state a completed read leads to. When the read handed back the very transcript object the
 * previous loaded state holds, that state is returned as-is so a caller can skip its update.
 */
export function nextTranscriptState(
  previous: TranscriptState | null,
  transcript: AgentTranscript | null,
): TranscriptState {
  if (!transcript) return { kind: "absent" };
  if (previous?.kind === "loaded" && previous.transcript === transcript) return previous;
  return { kind: "loaded", transcript };
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
