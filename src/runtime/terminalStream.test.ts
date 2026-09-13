import { describe, expect, it } from "vitest";
import type { SessionStreamFrame } from "./sessionFrame";
import { type TerminalStreamChunk, createTerminalStreamConsumer } from "./terminalStream";

function frame(overrides: Partial<SessionStreamFrame>): SessionStreamFrame {
  return {
    runId: 1,
    start: 0,
    next: 0,
    bytes: new Uint8Array(0),
    truncated: false,
    running: true,
    exitCode: null,
    readClosed: false,
    ended: false,
    error: null,
    ...overrides,
  };
}

const text = (value: string) => new TextEncoder().encode(value);
const asText = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("terminal stream consumer", () => {
  it("writes frames in order and commits the cursor only after each write lands", async () => {
    const committed: Array<{ next: number; text: string; suppressed: boolean }> = [];
    const statuses: number[] = [];
    let cursor = 0;
    const consumer = createTerminalStreamConsumer({
      commit: async (chunk) => {
        // Simulate xterm finishing writes out of step with the arrival of frames.
        await new Promise((resolve) => setTimeout(resolve, chunk.bytes.length % 3));
        committed.push({
          next: chunk.next,
          text: asText(chunk.bytes),
          suppressed: chunk.suppressProtocolInput,
        });
        cursor = chunk.next;
        return true;
      },
      truncatedMarker: () => text("<gap>"),
      replayThrough: () => 0,
      status: (current) => statuses.push(current.next),
    });

    void consumer.push(frame({ start: 0, next: 5, bytes: text("hello") }));
    void consumer.push(frame({ start: 5, next: 11, bytes: text(" world") }));
    await consumer.push(frame({ start: 11, next: 11 }));

    // A status-only frame that moves nothing commits nothing, but its status is still reported.
    expect(committed).toEqual([
      { next: 5, text: "hello", suppressed: false },
      { next: 11, text: " world", suppressed: false },
    ]);
    expect(cursor).toBe(11);
    expect(statuses).toEqual([5, 11, 11]);
  });

  it("suppresses protocol responses for the replayed part of a frame only", async () => {
    const committed: TerminalStreamChunk[] = [];
    const consumer = createTerminalStreamConsumer({
      commit: async (chunk) => {
        committed.push(chunk);
        return true;
      },
      truncatedMarker: () => text("<gap>"),
      replayThrough: () => 3,
      status: () => undefined,
    });

    await consumer.push(frame({ start: 0, next: 6, bytes: text("abcdef") }));

    expect(committed.map((chunk) => [asText(chunk.bytes), chunk.suppressProtocolInput])).toEqual([
      ["abc", true],
      ["def", false],
    ]);
    expect(committed.map((chunk) => chunk.next)).toEqual([3, 6]);
  });

  it("marks a gap in history before the frame that follows it", async () => {
    const committed: string[] = [];
    const consumer = createTerminalStreamConsumer({
      commit: async (chunk) => {
        committed.push(`${asText(chunk.bytes)}@${chunk.next}`);
        return true;
      },
      truncatedMarker: () => text("<gap>"),
      replayThrough: () => 0,
      status: () => undefined,
    });

    await consumer.push(frame({ start: 900, next: 903, bytes: text("new"), truncated: true }));

    expect(committed).toEqual(["<gap>@900", "new@903"]);
  });

  it("stops at a refused commit and never reports status for a frame it could not finish", async () => {
    const committed: number[] = [];
    let statuses = 0;
    const consumer = createTerminalStreamConsumer({
      commit: async (chunk) => {
        committed.push(chunk.next);
        return chunk.next !== 6;
      },
      truncatedMarker: () => text("<gap>"),
      replayThrough: () => 2,
      status: () => {
        statuses += 1;
      },
    });

    await consumer.push(frame({ start: 0, next: 6, bytes: text("abcdef") }));
    await consumer.push(frame({ start: 6, next: 7, bytes: text("g") }));

    // The second chunk of the first frame was refused; the second frame still ran on its own.
    expect(committed).toEqual([2, 6, 7]);
    expect(statuses).toBe(1);
  });

  it("drops frames not yet started after stop but lets an in-flight write commit", async () => {
    const committed: number[] = [];
    let release: (() => void) | undefined;
    const consumer = createTerminalStreamConsumer({
      commit: async (chunk) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        committed.push(chunk.next);
        return true;
      },
      truncatedMarker: () => text("<gap>"),
      replayThrough: () => 0,
      status: () => undefined,
    });

    const first = consumer.push(frame({ start: 0, next: 1, bytes: text("a") }));
    const second = consumer.push(frame({ start: 1, next: 2, bytes: text("b") }));
    await Promise.resolve();
    consumer.stop();
    release?.();
    await first;
    await second;

    // The write xterm already had commits its cursor; the queued frame is never written.
    expect(committed).toEqual([1]);
  });
});
