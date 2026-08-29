/**
 * Writes outrank reads — as a hint, never as a lock.
 *
 * The broker speaks lockstep per connection, and against a broker that serves one client at a time
 * the app is held to a single connection — so a keystroke's write waits behind however many
 * background polls happen to be in flight. Panes poll constantly; a person types rarely. Letting
 * the constant traffic block the rare traffic is what made typing and pasting feel like a stall.
 *
 * A poll asks this gate before its turn and yields while a write is outstanding. Two rules keep
 * that from becoming the bigger problem:
 *
 * - The wait is bounded. A write that never comes back must not stop output. On Windows the broker
 *   connection has no read timeout, so a wedged write blocks its caller forever; when this gate was
 *   an unbounded promise, that one write froze every pane in the app permanently.
 * - The gate is per session. It was one process-wide counter, so a stuck write in one pane held
 *   back the polls of every other pane, including ones talking over entirely different pooled
 *   connections.
 */

/** How long a poll defers to an outstanding write before going anyway. */
const MAX_DEFERRAL_MS = 250;

const outstanding = new Map<string, number>();
const waiting = new Map<string, Set<() => void>>();

/** Every gate shares one key when a caller names none, matching the old process-wide behaviour. */
const SHARED = "*";

function release(key: string) {
  const resumes = waiting.get(key);
  if (!resumes) return;
  waiting.delete(key);
  for (const resume of resumes) resume();
}

/** Wraps a write so polls for the same session stand aside for its duration, however it ends. */
export async function withWritePriority<T>(write: () => Promise<T>, key = SHARED): Promise<T> {
  outstanding.set(key, (outstanding.get(key) ?? 0) + 1);
  try {
    return await write();
  } finally {
    // Clamped at zero: a reset while a write was in flight used to drive the count negative, after
    // which the "=== 0" release could never fire again and every poll waited forever.
    const next = Math.max(0, (outstanding.get(key) ?? 0) - 1);
    if (next === 0) {
      outstanding.delete(key);
      release(key);
    } else {
      outstanding.set(key, next);
    }
  }
}

export function writeInFlight(key = SHARED): boolean {
  return (outstanding.get(key) ?? 0) > 0;
}

/**
 * Resolves once no write for this session is outstanding — immediately when none is, and after
 * MAX_DEFERRAL_MS regardless. Deferring is worth a moment of latency; it is never worth silence.
 */
export function awaitWriteIdle(key = SHARED): Promise<void> {
  if (!writeInFlight(key)) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, MAX_DEFERRAL_MS);
    const resumes = waiting.get(key) ?? new Set<() => void>();
    resumes.add(finish);
    waiting.set(key, resumes);
  });
}

/** Test seam: the module is process-wide state, so a test must be able to reset it. */
export function resetWritePriority(): void {
  outstanding.clear();
  for (const key of [...waiting.keys()]) release(key);
  waiting.clear();
}
