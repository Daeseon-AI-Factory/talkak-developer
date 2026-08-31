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

  it("does not retain a renderer copy after a completed native prewarm", async () => {
    let calls = 0;
    const client = createTranscriptClient(
      async <T>() => {
        calls += 1;
        return transcript as T;
      },
      () => true,
    );

    await client.prewarm(scope);
    await expect(client.read(scope)).resolves.toEqual(transcript);
    expect(calls).toBe(2);
  });
});
