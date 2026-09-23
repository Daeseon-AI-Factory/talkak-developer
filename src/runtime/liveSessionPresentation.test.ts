import { describe, expect, it } from "vitest";
import {
  liveSessionProgram,
  liveSessionsById,
  relativeAge,
  sortByRecentActivity,
} from "./liveSessionPresentation";
import type { LiveSession } from "./sessionClient";

const MINUTE = 60_000;

function session(overrides: Partial<LiveSession>): LiveSession {
  return {
    sessionId: "s",
    runId: 1,
    processId: 1,
    running: true,
    ...overrides,
  };
}

describe("live session presentation", () => {
  it("coarsens an age to the unit a person would say", () => {
    const now = 1_000_000_000_000;
    expect(relativeAge(now, now - 2_000)).toEqual({ unit: "now", value: 0 });
    expect(relativeAge(now, now - 45_000)).toEqual({ unit: "seconds", value: 45 });
    expect(relativeAge(now, now - 7 * MINUTE)).toEqual({ unit: "minutes", value: 7 });
    expect(relativeAge(now, now - 3 * 60 * MINUTE)).toEqual({ unit: "hours", value: 3 });
    expect(relativeAge(now, now - 49 * 60 * MINUTE)).toEqual({ unit: "days", value: 2 });
    // A stamp from a clock ahead of ours is not a negative age.
    expect(relativeAge(now, now + MINUTE)).toEqual({ unit: "now", value: 0 });
  });

  it("names the program by its last path segment on either OS", () => {
    expect(liveSessionProgram(session({ command: "/opt/homebrew/bin/agent-cli" }))).toBe(
      "agent-cli",
    );
    expect(liveSessionProgram(session({ command: "C:\\Tools\\agent.exe" }))).toBe("agent.exe");
    expect(liveSessionProgram(session({ command: "  codex  " }))).toBe("codex");
    // The OS default shell is the caller's word, not a hardcoded one here.
    expect(liveSessionProgram(session({ command: null }))).toBeNull();
    expect(liveSessionProgram(session({}))).toBeNull();
    expect(liveSessionProgram(session({ command: "   " }))).toBeNull();
  });

  it("orders by last output, then by launch, and joins by id", () => {
    const quiet = session({ sessionId: "quiet", startedAtMs: 500, lastOutputMs: null });
    const busy = session({ sessionId: "busy", startedAtMs: 100, lastOutputMs: 900 });
    const older = session({ sessionId: "older", startedAtMs: 100, lastOutputMs: 300 });
    const legacy = session({ sessionId: "legacy" });
    expect(sortByRecentActivity([legacy, quiet, older, busy]).map((s) => s.sessionId)).toEqual([
      "busy",
      "quiet",
      "older",
      "legacy",
    ]);
    expect(liveSessionsById([busy, quiet]).get("quiet")).toBe(quiet);
  });
});
