import { useCallback, useEffect, useState } from "react";
import { type AgentTranscript, transcriptClient } from "./transcriptClient";

export type TranscriptState =
  | { kind: "unsupported" }
  | { kind: "loading" }
  | { kind: "absent" }
  | { kind: "failed"; message: string }
  | { kind: "loaded"; transcript: AgentTranscript };

/**
 * The agent transcript for a project, refreshed while the panel is open.
 *
 * Five states, not one list. "No record yet" and "the record could not be read" are different
 * facts, and this app has already shipped the wrong one twice — a refused clipboard that looked
 * like a successful copy, and a broker error that became an empty session list while twenty-two
 * shells were running. An empty array would have made the same mistake a third time.
 */
export function useAgentTranscript(
  projectPath: string | null,
  active: boolean,
  refreshMs = 4000,
): { state: TranscriptState } {
  const [state, setState] = useState<TranscriptState>(() =>
    transcriptClient.available() ? { kind: "loading" } : { kind: "unsupported" },
  );

  const load = useCallback(
    async (signal: { cancelled: boolean }) => {
      if (!transcriptClient.available()) {
        setState({ kind: "unsupported" });
        return;
      }
      if (!projectPath) {
        setState({ kind: "absent" });
        return;
      }
      try {
        const transcript = await transcriptClient.read(projectPath);
        if (signal.cancelled) return;
        setState(transcript ? { kind: "loaded", transcript } : { kind: "absent" });
      } catch (cause: unknown) {
        if (signal.cancelled) return;
        setState({
          kind: "failed",
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    },
    [projectPath],
  );

  useEffect(() => {
    if (!active) return;
    const signal = { cancelled: false };
    void load(signal);
    // The file grows while the agent works, so an open panel keeps up with it. Polling stops the
    // moment the panel closes — this reads a file that can be megabytes.
    const timer = setInterval(() => void load(signal), refreshMs);
    return () => {
      signal.cancelled = true;
      clearInterval(timer);
    };
  }, [active, load, refreshMs]);

  return { state };
}
