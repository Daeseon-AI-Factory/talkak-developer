import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTranscript, TranscriptScope } from "./transcriptClient";
import {
  startTranscriptRefresh,
  transcriptPhaseIsLive,
  useAgentTranscript,
} from "./useAgentTranscript";

const transcriptPeek = vi.hoisted(() => vi.fn());

vi.mock("./transcriptClient", async (importOriginal) => {
  const original = await importOriginal<typeof import("./transcriptClient")>();
  return {
    ...original,
    transcriptClient: {
      available: () => true,
      peek: transcriptPeek,
      read: vi.fn(async () => null),
      prewarm: vi.fn(async () => {}),
    },
  };
});

const scope: TranscriptScope = {
  sessionId: "session-1",
  runId: 3,
  projectPath: "C:\\project",
  startedAt: "2026-08-31T12:00:00.000Z",
  agentCommand: "codex",
};

const transcript: AgentTranscript = {
  source: "codex",
  path: "rollout.jsonl",
  entries: [{ role: "assistant", text: "cached answer", at: null }],
  totalEntries: 1,
  changedFiles: [],
  lastActivity: null,
};

beforeEach(() => {
  transcriptPeek.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("transcript refresh scheduling", () => {
  it("paints an exact completed prewarm on the first render", () => {
    transcriptPeek.mockReturnValue(transcript);

    function Probe() {
      const result = useAgentTranscript(scope, true, "running");
      return createElement("span", null, result.state.kind);
    }

    expect(renderToStaticMarkup(createElement(Probe))).toBe("<span>loaded</span>");
    expect(transcriptPeek).toHaveBeenCalledWith(scope, 800);
  });

  it("polls only while the agent process is live", () => {
    expect(transcriptPhaseIsLive("running")).toBe(true);
    expect(transcriptPhaseIsLive("stopping")).toBe(true);
    expect(transcriptPhaseIsLive("starting")).toBe(false);
    expect(transcriptPhaseIsLive("exited")).toBe(false);
    expect(transcriptPhaseIsLive("error")).toBe(false);
    expect(transcriptPhaseIsLive(null)).toBe(false);
  });

  it("reads a completed session once without leaving a polling timer", async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => {});
    const stop = startTranscriptRefresh(load, false, 4000);

    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(load).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does one final read when a live phase changes to exited", async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => {});
    const stopLive = startTranscriptRefresh(load, true, 4000);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4000);
    expect(load).toHaveBeenCalledTimes(2);

    stopLive();
    const stopExited = startTranscriptRefresh(load, false, 4000);
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(8000);
    expect(load).toHaveBeenCalledTimes(3);
    stopExited();
  });
});
