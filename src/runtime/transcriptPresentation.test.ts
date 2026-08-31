import { describe, expect, it } from "vitest";
import { latestAssistantExcerpt } from "./transcriptPresentation";

describe("transcript presentation", () => {
  it("summarizes the latest assistant turn without inventing text", () => {
    expect(
      latestAssistantExcerpt([
        { role: "assistant", text: "old answer", at: null },
        { role: "user", text: "question", at: null },
        { role: "assistant", text: "  latest\n\nanswer  ", at: null },
      ]),
    ).toBe("latest answer");
    expect(latestAssistantExcerpt([{ role: "user", text: "question", at: null }])).toBeNull();
  });

  it("bounds a long summary excerpt at a word boundary", () => {
    const excerpt = latestAssistantExcerpt(
      [{ role: "assistant", text: "one two three four five six", at: null }],
      18,
    );

    expect(excerpt).toBe("one two three…");
    expect(excerpt?.length).toBeLessThanOrEqual(18);
  });
});
