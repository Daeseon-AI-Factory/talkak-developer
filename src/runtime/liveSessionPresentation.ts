import type { LiveSession } from "./sessionClient";

/**
 * How a broker session is described to a person: what is running, where, since when, and how
 * long ago it last said anything. All pure, so the words can be tested without a broker.
 */

export type RelativeAgeUnit = "now" | "seconds" | "minutes" | "hours" | "days";

export interface RelativeAge {
  unit: RelativeAgeUnit;
  value: number;
}

/** `then` as a coarse age at `now`. A clock that runs backwards reads as "now", not a negative. */
export function relativeAge(nowMs: number, thenMs: number): RelativeAge {
  const seconds = Math.max(0, Math.floor((nowMs - thenMs) / 1000));
  if (seconds < 5) return { unit: "now", value: 0 };
  if (seconds < 60) return { unit: "seconds", value: seconds };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { unit: "minutes", value: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: "hours", value: hours };
  return { unit: "days", value: Math.floor(hours / 24) };
}

/**
 * The program name a row shows: the last path segment of the configured command, so
 * `/opt/homebrew/bin/agent-cli` reads as `agent-cli`. Null when the run uses the OS default
 * shell — the caller names that in its own language.
 */
export function liveSessionProgram(session: Pick<LiveSession, "command">): string | null {
  const command = session.command?.trim();
  if (!command) return null;
  const segments = command.split(/[\\/]/u).filter(Boolean);
  return segments[segments.length - 1] ?? command;
}

/** Sessions with the most recent output first; never-output sessions after, newest launch first. */
export function sortByRecentActivity(sessions: readonly LiveSession[]): LiveSession[] {
  return [...sessions].sort(
    (left, right) =>
      (right.lastOutputMs ?? right.startedAtMs ?? 0) - (left.lastOutputMs ?? left.startedAtMs ?? 0),
  );
}

/** The broker rows keyed by session id, for joining into the workspace's own session table. */
export function liveSessionsById(sessions: readonly LiveSession[]): Map<string, LiveSession> {
  return new Map(sessions.map((session) => [session.sessionId, session]));
}
