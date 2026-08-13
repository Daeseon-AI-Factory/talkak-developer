import { describe, expect, it } from "vitest";
import type { SessionRead } from "./sessionClient";
import { initialSessionLogCursor, readSessionLogFrame } from "./sessionLogModel";

describe("session log model", () => {
  it("starts at the beginning of the current run", async () => {
    const after: number[] = [];
    const frame = await readSessionLogFrame(
      {
        read: async (_sessionId, cursor) => {
          after.push(cursor);
          return sessionRead({ runId: 4, next: 3, bytes: [65, 66, 67] });
        },
      },
      "session-1",
      initialSessionLogCursor,
    );

    expect(after).toEqual([0]);
    expect(frame.cursor).toEqual({ runId: 4, after: 3 });
    expect(frame.bytes).toEqual([65, 66, 67]);
    expect(frame.reset).toBe(false);
  });

  it("continues from the previous cursor for the same run", async () => {
    const after: number[] = [];
    const frame = await readSessionLogFrame(
      {
        read: async (_sessionId, cursor) => {
          after.push(cursor);
          return sessionRead({ runId: 4, start: 3, next: 5, bytes: [68, 69] });
        },
      },
      "session-1",
      { runId: 4, after: 3 },
    );

    expect(after).toEqual([3]);
    expect(frame.cursor).toEqual({ runId: 4, after: 5 });
  });

  it("replays from zero when the session id starts a new run", async () => {
    const after: number[] = [];
    const reads = [
      sessionRead({ runId: 8, start: 2, next: 2, bytes: [] }),
      sessionRead({ runId: 8, next: 4, bytes: [78, 69, 87, 10] }),
    ];
    const frame = await readSessionLogFrame(
      {
        read: async (_sessionId, cursor) => {
          after.push(cursor);
          const read = reads.shift();
          if (!read) throw new Error("Unexpected read");
          return read;
        },
      },
      "session-1",
      { runId: 7, after: 900 },
    );

    expect(after).toEqual([900, 0]);
    expect(frame.cursor).toEqual({ runId: 8, after: 4 });
    expect(frame.bytes).toEqual([78, 69, 87, 10]);
    expect(frame.reset).toBe(true);
  });
});

function sessionRead(overrides: Partial<SessionRead>): SessionRead {
  return {
    sessionId: "session-1",
    runId: 1,
    start: 0,
    next: 0,
    bytes: [],
    truncated: false,
    running: true,
    exitCode: null,
    readClosed: false,
    readError: null,
    ...overrides,
  };
}
