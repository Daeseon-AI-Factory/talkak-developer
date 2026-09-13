import { useCallback, useEffect, useState } from "react";
import { type LiveSession, errorMessage, sessionClient } from "./sessionClient";

/**
 * The broker's session list, refreshed on a timer while the caller is mounted — the `tmux ls`
 * behind the Sessions screen. One fetch feeds both the orphan list and the activity columns of
 * the known-session table, so the two never disagree about what the broker holds.
 */
export interface LiveSessionsState {
  sessions: LiveSession[];
  error: string | null;
  /** The running broker predates the request; an empty list would lie about what it holds. */
  unsupported: boolean;
  /** Wall-clock time of the last successful answer, for relative ages. */
  observedAtMs: number;
  refresh: () => Promise<void>;
}

export function useLiveSessions(intervalMs: number): LiveSessionsState {
  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [observedAtMs, setObservedAtMs] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    if (!sessionClient.available()) return;
    try {
      setSessions(await sessionClient.liveSessions());
      setObservedAtMs(Date.now());
      setError(null);
      setUnsupported(false);
    } catch (cause: unknown) {
      // A broker started before this feature existed does not know the request. Saying so beats
      // an empty list, which would claim there is nothing to clean up while dozens run.
      const message = errorMessage(cause);
      setSessions([]);
      if (/bad request|unexpected broker response/i.test(message)) {
        setUnsupported(true);
        setError(null);
      } else {
        setUnsupported(false);
        setError(message);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
    if (!sessionClient.available() || intervalMs <= 0) return;
    const timer = setInterval(() => void refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, refresh]);

  return { sessions, error, unsupported, observedAtMs, refresh };
}
