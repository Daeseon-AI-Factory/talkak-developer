import { afterEach, describe, expect, it, vi } from "vitest";
import { startTranscriptRefresh, transcriptPhaseIsLive } from "./useAgentTranscript";

afterEach(() => {
  vi.useRealTimers();
});

describe("transcript refresh scheduling", () => {
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
