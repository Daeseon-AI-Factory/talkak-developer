import type { TranscriptEntry } from "./transcriptClient";

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
