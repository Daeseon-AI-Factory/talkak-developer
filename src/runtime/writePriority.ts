/**
 * Writes outrank reads.
 *
 * The broker speaks lockstep per connection, and against a broker that serves one client at a
 * time the app is held to a single connection — so a keystroke's write waits behind however many
 * background polls happen to be in flight. Panes poll constantly; a person types rarely. Letting
 * the constant traffic block the rare traffic is what made typing and pasting feel like the app
 * had stalled.
 *
 * A poll asks this gate before its turn: while any write is outstanding, it yields.
 */

let outstandingWrites = 0;
const waiting = new Set<() => void>();

/** Wraps a write so polls stand aside for its whole duration, however it ends. */
export async function withWritePriority<T>(write: () => Promise<T>): Promise<T> {
  outstandingWrites += 1;
  try {
    return await write();
  } finally {
    outstandingWrites -= 1;
    if (outstandingWrites === 0) {
      for (const resume of [...waiting]) resume();
      waiting.clear();
    }
  }
}

export function writeInFlight(): boolean {
  return outstandingWrites > 0;
}

/** Resolves once no write is outstanding — immediately when none is. */
export function awaitWriteIdle(): Promise<void> {
  if (outstandingWrites === 0) return Promise.resolve();
  return new Promise((resolve) => waiting.add(resolve));
}

/** Test seam: the module is process-wide state, so a test must be able to reset it. */
export function resetWritePriority(): void {
  outstandingWrites = 0;
  for (const resume of [...waiting]) resume();
  waiting.clear();
}
