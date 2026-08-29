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

export interface TranscriptClient {
  available: () => boolean;
  /** The newest transcript for a project directory, or null when neither agent has written one. */
  read: (projectPath: string, limit?: number) => Promise<AgentTranscript | null>;
}

export function createTranscriptClient(
  invokeCommand: <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
  available: () => boolean,
): TranscriptClient {
  return {
    available,
    read: (projectPath, limit = 200) =>
      invokeCommand<AgentTranscript | null>("agent_transcript", { projectPath, limit }),
  };
}

export const transcriptClient = createTranscriptClient(invoke, isTauri);
