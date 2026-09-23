import type { AttentionRequest, AttentionRisk } from "./domain";

const riskPriority: Record<AttentionRisk, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

export type AttentionResolveFailure =
  | "not-found"
  | "already-resolved"
  | "revision-mismatch"
  | "invalid-choice";

export type AttentionResolveResult =
  | {
      ok: true;
      state: AttentionRequest[];
      request: AttentionRequest;
    }
  | {
      ok: false;
      state: readonly AttentionRequest[];
      reason: AttentionResolveFailure;
    };

/**
 * Returns a cross-project queue without mutating the source array.
 * Higher-risk work is first, then older ISO-8601 timestamps, then stable IDs.
 */
export function openAttentionRequests(state: readonly AttentionRequest[]): AttentionRequest[] {
  return state
    .filter((request) => request.status === "open")
    .sort(
      (left, right) =>
        riskPriority[left.risk] - riskPriority[right.risk] ||
        compareCreatedAt(left.createdAt, right.createdAt) ||
        left.id.localeCompare(right.id),
    );
}

function compareCreatedAt(left: string, right: string): number {
  const leftTimestamp = Date.parse(left);
  const rightTimestamp = Date.parse(right);
  if (Number.isFinite(leftTimestamp) && Number.isFinite(rightTimestamp)) {
    return leftTimestamp - rightTimestamp;
  }
  return left.localeCompare(right);
}

/**
 * Resolves one still-open request only when the caller observed its current revision.
 */
export function resolveAttentionRequest(
  state: readonly AttentionRequest[],
  id: string,
  revision: number,
  choiceId: string,
  resolvedAt: string,
): AttentionResolveResult {
  const requestIndex = state.findIndex((request) => request.id === id);
  if (requestIndex < 0) return { ok: false, state, reason: "not-found" };

  const request = state[requestIndex];
  if (request.status !== "open") {
    return { ok: false, state, reason: "already-resolved" };
  }
  if (request.revision !== revision) {
    return { ok: false, state, reason: "revision-mismatch" };
  }
  if (!request.choices.some((choice) => choice.id === choiceId)) {
    return { ok: false, state, reason: "invalid-choice" };
  }

  const resolvedRequest: AttentionRequest = {
    ...request,
    status: "resolved",
    revision: request.revision + 1,
    resolution: { choiceId, resolvedAt },
  };
  const nextState = state.map((candidate, index) =>
    index === requestIndex ? resolvedRequest : candidate,
  );

  return { ok: true, state: nextState, request: resolvedRequest };
}
