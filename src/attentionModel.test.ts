import { describe, expect, it } from "vitest";
import { openAttentionRequests, resolveAttentionRequest } from "./attentionModel";
import type { AttentionRequest } from "./domain";

function request(id: string, overrides: Partial<AttentionRequest> = {}): AttentionRequest {
  return {
    id,
    projectId: `project-${id}`,
    sessionId: `session-${id}`,
    kind: "question",
    risk: "low",
    title: `Question ${id}`,
    description: `Choose an answer for ${id}.`,
    choices: [
      { id: "continue", label: "Continue" },
      { id: "stop", label: "Stop" },
    ],
    createdAt: "2026-08-08T12:00:00-04:00",
    status: "open",
    revision: 1,
    resolution: null,
    ...overrides,
  };
}

describe("attention model", () => {
  it("returns one open queue across projects in risk, age, and ID order", () => {
    const state = [
      request("resolved", {
        risk: "high",
        status: "resolved",
        resolution: { choiceId: "stop", resolvedAt: "2026-08-08T12:05:00-04:00" },
      }),
      request("low", { risk: "low" }),
      request("high-new", { risk: "high", createdAt: "2026-08-08T13:00:00-04:00" }),
      request("high-old-b", { risk: "high", createdAt: "2026-08-08T11:00:00-04:00" }),
      request("high-old-a", { risk: "high", createdAt: "2026-08-08T11:00:00-04:00" }),
      request("medium", { risk: "medium" }),
    ];

    expect(openAttentionRequests(state).map((item) => item.id)).toEqual([
      "high-old-a",
      "high-old-b",
      "high-new",
      "medium",
      "low",
    ]);
    expect(state.map((item) => item.id)).toEqual([
      "resolved",
      "low",
      "high-new",
      "high-old-b",
      "high-old-a",
      "medium",
    ]);
  });

  it("resolves a current open request without mutating the previous state", () => {
    const original = request("approval", { kind: "approval", revision: 7 });
    const state = [original, request("other")];

    const result = resolveAttentionRequest(
      state,
      "approval",
      7,
      "continue",
      "2026-08-08T12:10:00-04:00",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected the request to resolve");
    expect(result.state).not.toBe(state);
    expect(result.request).toMatchObject({
      id: "approval",
      status: "resolved",
      revision: 8,
      resolution: {
        choiceId: "continue",
        resolvedAt: "2026-08-08T12:10:00-04:00",
      },
    });
    expect(result.state[1]).toBe(state[1]);
    expect(original).toMatchObject({ status: "open", revision: 7, resolution: null });
  });

  it("sorts timestamps by their instant even when offsets differ", () => {
    const state = [
      request("later", { createdAt: "2026-08-08T10:45:00Z" }),
      request("earlier-offset", { createdAt: "2026-08-08T12:30:00+02:00" }),
    ];

    expect(openAttentionRequests(state).map((item) => item.id)).toEqual([
      "earlier-offset",
      "later",
    ]);
  });

  it("rejects a stale revision and preserves the exact state reference", () => {
    const state = [request("approval", { revision: 4 })];

    const result = resolveAttentionRequest(
      state,
      "approval",
      3,
      "continue",
      "2026-08-08T12:10:00-04:00",
    );

    expect(result).toEqual({ ok: false, state, reason: "revision-mismatch" });
    expect(result.state).toBe(state);
  });

  it("rejects choices not offered by the current request", () => {
    const state = [request("approval")];

    const result = resolveAttentionRequest(
      state,
      "approval",
      1,
      "invented-choice",
      "2026-08-08T12:10:00-04:00",
    );

    expect(result).toEqual({ ok: false, state, reason: "invalid-choice" });
  });
});
