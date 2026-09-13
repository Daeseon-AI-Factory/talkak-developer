import { describe, expect, it } from "vitest";
import {
  type BrokerLogLine,
  countProblems,
  createBrokerLogClient,
  filterLogLines,
  logLinesAsText,
} from "./brokerLogClient";

const lines: BrokerLogLine[] = [
  { level: "info", text: "[10:00:03.000Z pid=1] exiting: idle" },
  { level: "problem", text: "[10:00:02.000Z pid=1] PANIC: boom" },
  { level: "info", text: "[10:00:01.000Z pid=1] spawn requested: session-1" },
];

describe("broker log client", () => {
  it("asks the native side for a bounded tail with the problems flag", async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = [];
    const client = createBrokerLogClient(
      async <T>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        return { path: "/data/broker/broker.log", present: true, lines, partial: false } as T;
      },
      () => true,
    );
    const tail = await client.tail(true, 500);
    expect(calls).toEqual([
      { command: "broker_log_tail", args: { onlyProblems: true, limit: 500 } },
    ]);
    expect(tail.lines).toHaveLength(3);
  });

  it("filters by text, counts problems, and copies oldest first", () => {
    expect(filterLogLines(lines, "")).toBe(lines);
    expect(filterLogLines(lines, "  Spawn ").map((line) => line.text)).toEqual([
      "[10:00:01.000Z pid=1] spawn requested: session-1",
    ]);
    expect(filterLogLines(lines, "nothing here")).toEqual([]);
    expect(countProblems(lines)).toBe(1);
    expect(logLinesAsText(lines)).toBe(
      [
        "[10:00:01.000Z pid=1] spawn requested: session-1",
        "[10:00:02.000Z pid=1] PANIC: boom",
        "[10:00:03.000Z pid=1] exiting: idle",
      ].join("\n"),
    );
  });
});
