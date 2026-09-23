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

/** A question the agent put to the user in this turn, with the offered options and the pick. */
export interface TranscriptDecision {
  question: string;
  options: string[];
  /** Null when the record holds no answer (yet). */
  selected: string | null;
}

export interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
  at: string | null;
  /** Tool names the turn invoked, in order, one per call — the view folds repeats into a count. */
  tools: string[];
  decisions: TranscriptDecision[];
}

export type TranscriptActivityState = "idle" | "thinking" | "working" | "needs-input" | "done";

export interface TranscriptActivity {
  state: TranscriptActivityState;
  lastTool: string | null;
  at: string | null;
}

/** Token totals summed over the record. Null when the agent's record carries no counts. */
export interface TranscriptUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  messages: number;
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
  /** Bumped by the native side whenever the bound record changed; sent back to skip a resend. */
  revision: number;
  activity: TranscriptActivity;
  usage: TranscriptUsage | null;
}

export interface TranscriptScope {
  sessionId: string;
  runId: number | null;
  projectPath: string;
  startedAt: string;
  agentCommand: string | null;
}

/** What the native `agent_transcript` command answers, tagged by `kind`. */
export type TranscriptReadResult =
  | { kind: "unchanged"; revision: number }
  | { kind: "transcript"; transcript: AgentTranscript }
  | { kind: "absent" };

export interface TranscriptClient {
  available: () => boolean;
  /** The last completed prewarm for this exact running session, if one is still retained. */
  peek: (scope: TranscriptScope, limit?: number) => AgentTranscript | undefined;
  /**
   * The transcript bound to this Talkak session, or null when its agent has not written one.
   * With `knownRevision`, an unchanged record resolves to the very object that revision came
   * from, so a caller holding it can skip its own update.
   */
  read: (
    scope: TranscriptScope,
    limit?: number,
    knownRevision?: number,
  ) => Promise<AgentTranscript | null>;
  /** Warm the native session binding/cache before a panel opens. */
  prewarm: (scope: TranscriptScope, limit?: number) => Promise<void>;
}

const DEFAULT_LIMIT = 800;

export function createTranscriptClient(
  invokeCommand: <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
  available: () => boolean,
): TranscriptClient {
  interface PendingRead {
    promise: Promise<AgentTranscript | null>;
  }

  const pending = new Map<string, PendingRead>();
  // Workspace warms only its active session. One exact-key slot gives that panel an immediate first
  // paint without retaining every large transcript the user has ever opened. The same slot is what
  // an "unchanged" answer resolves to.
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

  async function readOnce(
    scope: TranscriptScope,
    limit: number,
    requestKey: string,
    knownRevision: number | undefined,
  ): Promise<AgentTranscript | null> {
    const args: Record<string, unknown> = { ...scope, limit };
    if (knownRevision !== undefined) args.knownRevision = knownRevision;
    const result = normalizeTranscriptRead(await invokeCommand<unknown>("agent_transcript", args));
    if (result.kind === "transcript") return result.transcript;
    if (result.kind === "absent") return null;
    const retained = completed?.key === requestKey ? completed.transcript : null;
    if (retained && retained.revision === result.revision) return retained;
    // Nothing retained to hand back (the slot moved to another session, or the caller's
    // revision came from elsewhere): ask for the full record, once, without a revision.
    return readOnce(scope, limit, requestKey, undefined);
  }

  function invokeRead(
    scope: TranscriptScope,
    limit: number,
    knownRevision: number | undefined,
  ): Promise<AgentTranscript | null> {
    const requestKey = key(scope, limit);
    latestRequestedKey = requestKey;
    const existing = pending.get(requestKey);
    if (existing) return existing.promise;

    const entry: PendingRead = { promise: readOnce(scope, limit, requestKey, knownRevision) };
    pending.set(requestKey, entry);
    void entry.promise.then(
      (transcript) => {
        pending.delete(requestKey);
        if (latestRequestedKey !== requestKey) return;
        if (transcript) completed = { key: requestKey, transcript };
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
    peek: (scope, limit = DEFAULT_LIMIT) => {
      // A session without a run id may be about to bind a different record; never paint the
      // retained one under it.
      if (scope.runId === null) return undefined;
      const requestKey = key(scope, limit);
      return completed?.key === requestKey ? completed.transcript : undefined;
    },
    read: (scope, limit = DEFAULT_LIMIT, knownRevision?: number) =>
      invokeRead(scope, limit, knownRevision),
    prewarm: async (scope, limit = DEFAULT_LIMIT) => {
      await invokeRead(scope, limit, undefined);
    },
  };
}

/**
 * Accept the tagged answer, and — for one release across the native/renderer seam — the older
 * untagged `AgentTranscript | null`, so a renderer ahead of its shell still shows the record.
 */
export function normalizeTranscriptRead(raw: unknown): TranscriptReadResult {
  if (raw === null || raw === undefined) return { kind: "absent" };
  if (typeof raw !== "object") return { kind: "absent" };
  const value = raw as Record<string, unknown>;
  if (value.kind === "unchanged" && typeof value.revision === "number") {
    return { kind: "unchanged", revision: value.revision };
  }
  if (value.kind === "absent") return { kind: "absent" };
  const candidate = (value.kind === "transcript" ? value.transcript : value) as
    | Record<string, unknown>
    | null
    | undefined;
  if (!candidate || typeof candidate !== "object" || !Array.isArray(candidate.entries)) {
    return { kind: "absent" };
  }
  return { kind: "transcript", transcript: withTranscriptDefaults(candidate) };
}

/**
 * Hands the object back untouched when it already has the full shape: the same reference is what
 * lets an unchanged read resolve to the retained transcript, so it must never be re-created.
 */
function withTranscriptDefaults(value: Record<string, unknown>): AgentTranscript {
  const rawEntries = value.entries as Record<string, unknown>[];
  const complete =
    typeof value.revision === "number" &&
    typeof value.activity === "object" &&
    value.activity !== null &&
    "usage" in value &&
    rawEntries.every((entry) => Array.isArray(entry.tools) && Array.isArray(entry.decisions));
  if (complete) return value as unknown as AgentTranscript;

  const entries = rawEntries.map((entry) =>
    Array.isArray(entry.tools) && Array.isArray(entry.decisions)
      ? (entry as unknown as TranscriptEntry)
      : ({
          ...entry,
          tools: Array.isArray(entry.tools) ? entry.tools : [],
          decisions: Array.isArray(entry.decisions) ? entry.decisions : [],
        } as unknown as TranscriptEntry),
  );
  const activity = value.activity as TranscriptActivity | undefined;
  return {
    ...(value as unknown as AgentTranscript),
    entries,
    revision: typeof value.revision === "number" ? value.revision : 0,
    activity: activity ?? { state: "idle", lastTool: null, at: null },
    usage: (value.usage as TranscriptUsage | undefined) ?? null,
  };
}

export const transcriptClient = createTranscriptClient(invoke, isTauri);
