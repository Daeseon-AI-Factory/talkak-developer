import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * The agent's own record of a session, read from disk through the native boundary.
 *
 * Claude Code and codex each write a structured JSONL transcript of their own run. That is a far
 * better source for the summary and conversation panels than scraping the terminal: the turns are
 * already separated, the text is not wrapped to the pane width, and edited files are named rather
 * than inferred from prose. The native side does the reading and the trimming — one of these files
 * reached 16 MB in a single session.
 */
export interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
  at: string | null;
}

export interface AgentTranscript {
  /** Which agent wrote the record: "claude" or "codex". */
  source: string;
  /** The record's own path, so a reader can go and find it. */
  path: string;
  /** Newest last, capped by the requested limit. */
  entries: TranscriptEntry[];
  /** Turns in the whole record, so a trimmed tail can say what it left out. */
  totalEntries: number;
  /** Files the agent edited or wrote, most recently touched last. */
  changedFiles: string[];
  lastActivity: string | null;
}

export interface TranscriptScope {
  sessionId: string;
  runId: number | null;
  projectPath: string;
  startedAt: string;
  agentCommand: string | null;
}

export interface TranscriptClient {
  available: () => boolean;
  /** The last completed prewarm for this exact running session, if one is still retained. */
  peek: (scope: TranscriptScope, limit?: number) => AgentTranscript | undefined;
  /** The transcript bound to this Talkak session, or null when its agent has not written one. */
  read: (scope: TranscriptScope, limit?: number) => Promise<AgentTranscript | null>;
  /** Warm the native session binding/cache before a panel opens. */
  prewarm: (scope: TranscriptScope, limit?: number) => Promise<void>;
}

export function createTranscriptClient(
  invokeCommand: <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
  available: () => boolean,
): TranscriptClient {
  interface PendingRead {
    promise: Promise<AgentTranscript | null>;
  }

  const pending = new Map<string, PendingRead>();
  // Workspace warms only its active session. One exact-key slot gives that panel an immediate first
  // paint without retaining every large transcript the user has ever opened.
  let completed: { key: string; transcript: AgentTranscript } | null = null;
  let latestRequestedKey: string | null = null;

  function key(scope: TranscriptScope, limit: number): string {
    return JSON.stringify([
      scope.sessionId,
      scope.runId,
      scope.projectPath,
      scope.startedAt,
      scope.agentCommand,
      limit,
    ]);
  }

  function invokeRead(scope: TranscriptScope, limit: number): Promise<AgentTranscript | null> {
    const requestKey = key(scope, limit);
    latestRequestedKey = requestKey;
    const existing = pending.get(requestKey);
    if (existing) return existing.promise;

    const entry: PendingRead = {
      promise: invokeCommand<AgentTranscript | null>("agent_transcript", { ...scope, limit }),
    };
    pending.set(requestKey, entry);
    void entry.promise.then(
      (transcript) => {
        pending.delete(requestKey);
        if (latestRequestedKey !== requestKey) return;
        if (transcript && scope.runId !== null) completed = { key: requestKey, transcript };
        else if (completed?.key === requestKey) completed = null;
      },
      () => {
        pending.delete(requestKey);
        if (latestRequestedKey === requestKey && completed?.key === requestKey) completed = null;
      },
    );
    return entry.promise;
  }

  return {
    available,
    peek: (scope, limit = 800) => {
      if (scope.runId === null) return undefined;
      const requestKey = key(scope, limit);
      return completed?.key === requestKey ? completed.transcript : undefined;
    },
    read: (scope, limit = 800) => invokeRead(scope, limit),
    prewarm: async (scope, limit = 800) => {
      await invokeRead(scope, limit);
    },
  };
}

export const transcriptClient = createTranscriptClient(invoke, isTauri);
