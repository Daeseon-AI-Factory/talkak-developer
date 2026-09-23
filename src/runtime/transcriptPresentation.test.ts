import { describe, expect, it } from "vitest";
import type { AgentTranscript, TranscriptEntry } from "./transcriptClient";
import {
  formatTokenCount,
  latestAssistantExcerpt,
  previewDisplayEntries,
  toolSummary,
  transcriptDayKey,
  transcriptDayLabel,
  transcriptDisplayEntries,
} from "./transcriptPresentation";

const entry = (role: TranscriptEntry["role"], text: string, at: string | null = null) => ({
  role,
  text,
  at,
  tools: [],
  decisions: [],
});

describe("transcript presentation", () => {
  it("summarizes the latest assistant turn without inventing text", () => {
    expect(
      latestAssistantExcerpt([
        entry("assistant", "old answer"),
        entry("user", "question"),
        entry("assistant", "  latest\n\nanswer  "),
      ]),
    ).toBe("latest answer");
    expect(latestAssistantExcerpt([entry("user", "question")])).toBeNull();
  });

  it("bounds a long summary excerpt at a word boundary", () => {
    const excerpt = latestAssistantExcerpt([entry("assistant", "one two three four five six")], 18);

    expect(excerpt).toBe("one two three…");
    expect(excerpt?.length).toBeLessThanOrEqual(18);
  });

  it("folds repeated tool calls into a count, in first-use order", () => {
    expect(toolSummary(["Read", "Bash", "Read", "Read"])).toBe("Read ×3 · Bash");
    expect(toolSummary(["shell"])).toBe("shell");
    expect(toolSummary([])).toBe("");
  });

  it("labels the two most recent days by name and older ones by date", () => {
    const now = new Date(2026, 8, 1, 15, 30);
    const labels = { today: "오늘", yesterday: "어제" };

    expect(transcriptDayLabel(new Date(2026, 8, 1, 0, 5).toISOString(), labels, now)).toBe("오늘");
    expect(transcriptDayLabel(new Date(2026, 7, 31, 23, 59).toISOString(), labels, now)).toBe(
      "어제",
    );
    const older = transcriptDayLabel(new Date(2026, 7, 30, 12, 0).toISOString(), labels, now);
    expect(older).not.toBe("오늘");
    expect(older).not.toBe("어제");
    expect(older).toContain("30");
    expect(transcriptDayLabel("not a date", labels, now)).toBe("");
  });

  it("groups entries by local calendar day and skips entries without a time", () => {
    expect(transcriptDayKey(new Date(2026, 8, 1, 1, 0).toISOString())).toBe(
      transcriptDayKey(new Date(2026, 8, 1, 23, 0).toISOString()),
    );
    expect(transcriptDayKey(new Date(2026, 8, 1).toISOString())).not.toBe(
      transcriptDayKey(new Date(2026, 8, 2).toISOString()),
    );
    expect(transcriptDayKey(null)).toBe("");
    expect(transcriptDayKey("garbage")).toBe("");
  });

  it("formats token counts as sizes, not accounting figures", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(512)).toBe("512");
    expect(formatTokenCount(1000)).toBe("1k");
    expect(formatTokenCount(1234)).toBe("1.2k");
    expect(formatTokenCount(4_500_000)).toBe("4.5M");
    expect(formatTokenCount(Number.NaN)).toBe("0");
  });

  it("keys record entries by their position in the whole record so a trimmed head stays stable", () => {
    const transcript: AgentTranscript = {
      source: "claude",
      path: "session.jsonl",
      entries: [
        entry("user", "hello", "2026-09-01T10:00:00.000Z"),
        { ...entry("assistant", "hi"), tools: ["Read"] },
      ],
      totalEntries: 12,
      changedFiles: [],
      lastActivity: null,
      revision: 1,
      activity: { state: "idle", lastTool: null, at: null },
      usage: null,
    };

    const entries = transcriptDisplayEntries(transcript);

    expect(entries.map((item) => item.key)).toEqual(["2026-09-01T10:00:00.000Z-10", "no-time-11"]);
    expect(entries[0]?.author).toBe("you");
    expect(entries[1]?.author).toBe("agent");
    expect(entries[1]?.tools).toEqual(["Read"]);
    expect(entries[0]?.time).not.toBe("");
  });

  it("gives seeded preview turns no timestamp, so they never get a day separator", () => {
    const entries = previewDisplayEntries([
      { id: "turn-1", author: "system", time: "12:00", text: "seeded" },
    ]);

    expect(entries).toEqual([
      {
        key: "turn-1",
        author: "system",
        at: null,
        time: "12:00",
        text: "seeded",
        tools: [],
        decisions: [],
      },
    ]);
  });
});
