import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * The broker's lifecycle log, through the native command boundary. It is the broker's log and
 * nothing else — the app writes no runtime log of its own — and the panel that shows it says so.
 */
export type BrokerLogLevel = "problem" | "info";

export interface BrokerLogLine {
  /** A heuristic: the broker writes no level field, so "problem" means the line reads like one. */
  level: BrokerLogLevel;
  text: string;
}

export interface BrokerLogTail {
  /** Where the log lives on this machine, or null when the app has no data directory. */
  path: string | null;
  /** Whether that file exists. A broker that has never run has none. */
  present: boolean;
  /** Newest first. */
  lines: BrokerLogLine[];
  /** Whether the file is longer than the tail that was read. */
  partial: boolean;
}

export interface BrokerLogClient {
  available: () => boolean;
  tail: (onlyProblems: boolean, limit: number) => Promise<BrokerLogTail>;
}

export function createBrokerLogClient(
  invokeCommand: <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
  available: () => boolean,
): BrokerLogClient {
  return {
    available,
    tail: (onlyProblems, limit) =>
      invokeCommand<BrokerLogTail>("broker_log_tail", { onlyProblems, limit }),
  };
}

export const brokerLogClient: BrokerLogClient = isTauri()
  ? createBrokerLogClient(invoke, isTauri)
  : {
      available: () => false,
      tail: async () => ({ path: null, present: false, lines: [], partial: false }),
    };

/** The lines whose text contains `query`, case-insensitively; every line for a blank query. */
export function filterLogLines(
  lines: readonly BrokerLogLine[],
  query: string,
): readonly BrokerLogLine[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return lines;
  return lines.filter((line) => line.text.toLocaleLowerCase().includes(needle));
}

/** What Copy puts on the clipboard: oldest first, one line each, the way the file reads. */
export function logLinesAsText(lines: readonly BrokerLogLine[]): string {
  return [...lines]
    .reverse()
    .map((line) => line.text)
    .join("\n");
}

export function countProblems(lines: readonly BrokerLogLine[]): number {
  return lines.filter((line) => line.level === "problem").length;
}
