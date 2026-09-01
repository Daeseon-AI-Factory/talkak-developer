import { describe, expect, it } from "vitest";
import type { AgentTranscript, TranscriptScope } from "./transcriptClient";
import { createTranscriptClient } from "./transcriptClient";

const scope: TranscriptScope = {
  sessionId: "session-1",
  runId: 3,
  projectPath: "C:\\project",
  startedAt: "2026-08-31T12:00:00.000Z",
  agentCommand: "codex",
};

const transcript: AgentTranscript = {
  source: "codex",
  path: "rollout.jsonl",
  entries: [],
  totalEntries: 0,
  changedFiles: [],
  lastActivity: null,
};

describe("transcript client", () => {
  it("passes the Talkak session scope and recent 800-turn tail to the native command", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const client = createTranscriptClient(
      async <T>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        return transcript as T;
      },
      () => true,
    );

    await client.read(scope);

    expect(calls).toEqual([
      {
        command: "agent_transcript",
        args: { ...scope, limit: 800 },
      },
    ]);
  });

  it("coalesces an in-flight prewarm with the first panel read", async () => {
    let resolve: ((value: AgentTranscript | null) => void) | undefined;
    const pending = new Promise<AgentTranscript | null>((done) => {
      resolve = done;
    });
    let calls = 0;
    const client = createTranscriptClient(
      async <T>() => {
        calls += 1;
        return (await pending) as T;
      },
      () => true,
    );

    const warming = client.prewarm(scope);
    const reading = client.read(scope);
    resolve?.(transcript);

    await expect(reading).resolves.toEqual(transcript);
    await warming;
    expect(calls).toBe(1);
  });

  it("keeps one completed prewarm for an immediate paint but still revalidates on read", async () => {
    let calls = 0;
    const refreshed = { ...transcript, totalEntries: 1 };
    const client = createTranscriptClient(
      async <T>() => {
        calls += 1;
        return (calls === 1 ? transcript : refreshed) as T;
      },
      () => true,
    );

    await client.prewarm(scope);
    expect(client.peek(scope)).toBe(transcript);
    await expect(client.read(scope)).resolves.toEqual(refreshed);
    expect(client.peek(scope)).toBe(refreshed);
    expect(calls).toBe(2);
  });

  it("never exposes a completed transcript to another or unknown run", async () => {
    const client = createTranscriptClient(
      async <T>() => transcript as T,
      () => true,
    );

    await client.prewarm(scope);

    expect(client.peek({ ...scope, runId: 4 })).toBeUndefined();
    expect(client.peek({ ...scope, runId: null })).toBeUndefined();
  });

  it("does not retain an absent or failed prewarm", async () => {
    const absent = createTranscriptClient(
      async <T>() => null as T,
      () => true,
    );
    await absent.prewarm(scope);
    expect(absent.peek(scope)).toBeUndefined();

    const failed = createTranscriptClient(
      async () => {
        throw new Error("unreadable");
      },
      () => true,
    );
    await expect(failed.prewarm(scope)).rejects.toThrow("unreadable");
    expect(failed.peek(scope)).toBeUndefined();
  });

  it("bounds the completed renderer cache to the most recently requested session", async () => {
    const otherScope = { ...scope, sessionId: "session-2", runId: 4 };
    const otherTranscript = { ...transcript, path: "other.jsonl" };
    const client = createTranscriptClient(
      async <T>(_command: string, args?: Record<string, unknown>) =>
        (args?.sessionId === otherScope.sessionId ? otherTranscript : transcript) as T,
      () => true,
    );

    await client.prewarm(scope);
    await client.prewarm(otherScope);

    expect(client.peek(scope)).toBeUndefined();
    expect(client.peek(otherScope)).toBe(otherTranscript);
  });
});
