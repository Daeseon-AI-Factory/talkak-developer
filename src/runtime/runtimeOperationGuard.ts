import type { TerminalRuntimePhase, TerminalRuntimeStatus } from "../domain";

export type GuardedRuntimeOperation = "write" | "resize";

export interface RuntimeOperationTracker {
  epoch: number;
  sequences: Record<GuardedRuntimeOperation, number>;
}

export interface RuntimeOperationToken {
  operation: GuardedRuntimeOperation;
  epoch: number;
  sequence: number;
  runId: number | null;
  phase: TerminalRuntimePhase;
}

export interface RuntimeMutationQueue {
  pending: Map<string, Promise<void>>;
}

export function createRuntimeOperationTracker(): RuntimeOperationTracker {
  return { epoch: 0, sequences: { write: 0, resize: 0 } };
}

export function createRuntimeMutationQueue(): RuntimeMutationQueue {
  return { pending: new Map() };
}

export function invalidateRuntimeOperations(tracker: RuntimeOperationTracker): number {
  tracker.epoch += 1;
  return tracker.epoch;
}

export function beginRuntimeOperation(
  tracker: RuntimeOperationTracker,
  operation: GuardedRuntimeOperation,
  status: TerminalRuntimeStatus,
): RuntimeOperationToken {
  tracker.sequences[operation] += 1;
  return {
    operation,
    epoch: tracker.epoch,
    sequence: tracker.sequences[operation],
    runId: status.runId,
    phase: status.phase,
  };
}

export function runtimeOperationIsCurrent(
  tracker: RuntimeOperationTracker,
  token: RuntimeOperationToken,
  status: TerminalRuntimeStatus | null,
): boolean {
  return (
    runtimeOperationBelongsToCurrentRuntime(tracker, token, status) &&
    token.sequence === tracker.sequences[token.operation]
  );
}

export function runtimeOperationBelongsToCurrentRuntime(
  tracker: RuntimeOperationTracker,
  token: RuntimeOperationToken,
  status: TerminalRuntimeStatus | null,
): boolean {
  return (
    status !== null &&
    token.epoch === tracker.epoch &&
    token.runId === status.runId &&
    token.phase === status.phase
  );
}

export function enqueueRuntimeMutation(
  queue: RuntimeMutationQueue,
  key: string,
  mutation: () => Promise<void>,
  onFailure: (cause: unknown) => void,
): Promise<void> {
  const previous = queue.pending.get(key) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(async () => {
      try {
        await mutation();
      } catch (cause: unknown) {
        onFailure(cause);
      }
    });
  queue.pending.set(key, current);
  const cleanup = () => {
    if (queue.pending.get(key) === current) queue.pending.delete(key);
  };
  void current.then(cleanup, cleanup);
  return current;
}
