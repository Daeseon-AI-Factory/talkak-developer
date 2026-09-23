import type { ConversationEntry } from "../domain";
import type { AgentTranscript, TranscriptDecision, TranscriptEntry } from "./transcriptClient";

export const INITIAL_TRANSCRIPT_TURNS = 60;
export const OLDER_TRANSCRIPT_PAGE = 80;

export function latestAssistantExcerpt(
  entries: readonly TranscriptEntry[],
  maxLength = 280,
): string | null {
  let latest: string | undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.role === "assistant") {
      latest = entries[index]?.text.trim();
      break;
    }
  }
  if (!latest) return null;

  const compact = latest.replace(/\s+/g, " ");
  if (compact.length <= maxLength) return compact;

  const candidate = compact.slice(0, maxLength - 1);
  const lastSpace = candidate.lastIndexOf(" ");
  const end = lastSpace >= Math.floor(maxLength * 0.65) ? lastSpace : candidate.length;
  return `${candidate.slice(0, end).trimEnd()}…`;
}

export function formatTranscriptTime(at: string | null): string {
  if (!at) return "";
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime())
    ? ""
    : parsed.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function formatTranscriptActivity(at: string | null): string | null {
  if (!at) return null;
  const parsed = new Date(at);
  if (Number.isNaN(parsed.getTime())) return at;
  return parsed.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** `Read ×3 · Bash` — every call is kept in the record; the view folds repeats into a count. */
export function toolSummary(tools: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const tool of tools) counts.set(tool, (counts.get(tool) ?? 0) + 1);
  return [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(" · ");
}

/** The calendar day a timestamp falls on, in the viewer's zone; "" when there is no usable time. */
export function transcriptDayKey(at: string | null): string {
  if (!at) return "";
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime()) ? "" : localDayKey(parsed);
}

export interface DayLabels {
  today: string;
  yesterday: string;
}

/** "Today" / "Yesterday" for the two most recent days, a local date for anything older. */
export function transcriptDayLabel(at: string, labels: DayLabels, now = new Date()): string {
  const parsed = new Date(at);
  if (Number.isNaN(parsed.getTime())) return "";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const key = localDayKey(parsed);
  if (key === localDayKey(now)) return labels.today;
  if (key === localDayKey(yesterday)) return labels.yesterday;
  return parsed.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/** 512 → "512", 1_234 → "1.2k", 4_500_000 → "4.5M": a size, not an accounting figure. */
export function formatTokenCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "0";
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) return `${trimZero((count / 1000).toFixed(1))}k`;
  return `${trimZero((count / 1_000_000).toFixed(1))}M`;
}

function trimZero(value: string): string {
  return value.endsWith(".0") ? value.slice(0, -2) : value;
}

/** One turn as the conversation views draw it, whichever record it came from. */
export interface DisplayConversationEntry {
  key: string;
  author: "you" | "agent" | "system";
  /** ISO timestamp when the record has one; drives the day separators. */
  at: string | null;
  time: string;
  text: string;
  tools: readonly string[];
  decisions: readonly TranscriptDecision[];
}

/** Seeded preview turns carry a clock time only, so they never get a day separator. */
export function previewDisplayEntries(
  conversation: readonly ConversationEntry[],
): DisplayConversationEntry[] {
  return conversation.map((entry) => ({
    key: entry.id,
    author: entry.author,
    at: null,
    time: entry.time,
    text: entry.text,
    tools: [],
    decisions: [],
  }));
}

/**
 * The record's turns, keyed by their position in the whole record so a trimmed head keeps the
 * remaining keys stable across refreshes.
 */
export function transcriptDisplayEntries(transcript: AgentTranscript): DisplayConversationEntry[] {
  const nativeStartIndex = Math.max(0, transcript.totalEntries - transcript.entries.length);
  return transcript.entries.map((entry, index) => ({
    key: `${entry.at ?? "no-time"}-${nativeStartIndex + index}`,
    author: entry.role === "user" ? "you" : "agent",
    at: entry.at,
    time: formatTranscriptTime(entry.at),
    text: entry.text,
    tools: entry.tools,
    decisions: entry.decisions,
  }));
}

export function conversationDisplayEntries(
  conversation: readonly ConversationEntry[],
  transcript: AgentTranscript | null,
  preview: boolean,
): DisplayConversationEntry[] {
  if (preview) return previewDisplayEntries(conversation);
  return transcript ? transcriptDisplayEntries(transcript) : [];
}
