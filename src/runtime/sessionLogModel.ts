export interface SessionLogCursor {
  runId: number | null;
  after: number;
}

export const initialSessionLogCursor: SessionLogCursor = { runId: null, after: 0 };

/**
 * Where a log view should resume for the run the engine currently holds: the retained cursor when
 * it belongs to that run, byte zero (and a cleared emulator) when the session has started a new one.
 */
export function sessionLogResumePoint(
  retained: SessionLogCursor,
  currentRunId: number | null,
): { after: number; reset: boolean } {
  if (currentRunId === null || retained.runId === null || retained.runId === currentRunId) {
    return { after: retained.after, reset: false };
  }
  return { after: 0, reset: true };
}
