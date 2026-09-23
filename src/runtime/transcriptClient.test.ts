import { describe, expect, it } from "vitest";
import type { AgentTranscript, TranscriptReadResult, TranscriptScope } from "./transcriptClient";
import { createTranscriptClient, normalizeTranscriptRead } from "./transcriptClient";

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
  revision: 3,
  activity: { state: "idle", lastTool: null, at: null },
  usage: null,
};

const loaded = (value: AgentTranscript): TranscriptReadResult => ({
  kind: "transcript",
  transcript: value,
});

type Call = { command: string; args?: Record<string, unknown> };

describe("transcript client", () => {
  it("passes the Talkak session scope, the 800-turn tail and a known revision to the native command", async () => {
    const calls: Call[] = [];
    const client = createTranscriptClient(
      async <T>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        return loaded(transcript) as T;
      },
      () => true,
    );

    await client.read(scope);
    await client.read(scope, 800, 3);

    expect(calls).toEqual([
      { command: "agent_transcript", args: { ...scope, limit: 800 } },
      { command: "agent_transcript", args: { ...scope, limit: 800, knownRevision: 3 } },
    ]);
  });

  it("coalesces an in-flight prewarm with the first panel read", async () => {
    let resolve: ((value: TranscriptReadResult) => void) | undefined;
    const pending = new Promise<TranscriptReadResult>((done) => {
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
    resolve?.(loaded(transcript));

    await expect(reading).resolves.toEqual(transcript);
    await warming;
    expect(calls).toBe(1);
  });

  it("keeps one completed prewarm for an immediate paint but still revalidates on read", async () => {
    let calls = 0;
    const refreshed = { ...transcript, totalEntries: 1, revision: 4 };
    const client = createTranscriptClient(
      async <T>() => {
        calls += 1;
        return loaded(calls === 1 ? transcript : refreshed) as T;
      },
      () => true,
    );

    await client.prewarm(scope);
    expect(client.peek(scope)).toBe(transcript);
    await expect(client.read(scope)).resolves.toEqual(refreshed);
    expect(client.peek(scope)).toBe(refreshed);
    expect(calls).toBe(2);
  });

  it("hands back the very object an unchanged answer refers to", async () => {
    let calls = 0;
    const client = createTranscriptClient(
      async <T>() => {
        calls += 1;
        return (calls === 1 ? loaded(transcript) : { kind: "unchanged", revision: 3 }) as T;
      },
      () => true,
    );

    const first = await client.read(scope);
    const second = await client.read(scope, 800, first?.revision);

    expect(second).toBe(first);
    expect(client.peek(scope)).toBe(first);
    expect(calls).toBe(2);
  });

  it("asks for the full record once when an unchanged answer has nothing retained behind it", async () => {
    const calls: Call[] = [];
    const client = createTranscriptClient(
      async <T>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        return (calls.length === 1 ? { kind: "unchanged", revision: 9 } : loaded(transcript)) as T;
      },
      () => true,
    );

    await expect(client.read(scope, 800, 9)).resolves.toBe(transcript);
    expect(calls.map((call) => call.args?.knownRevision)).toEqual([9, undefined]);
  });

  it("never exposes a completed transcript to another or unknown run", async () => {
    const client = createTranscriptClient(
      async <T>() => loaded(transcript) as T,
      () => true,
    );

    await client.prewarm(scope);

    expect(client.peek({ ...scope, runId: 4 })).toBeUndefined();
    expect(client.peek({ ...scope, runId: null })).toBeUndefined();
  });

  it("does not retain an absent or failed prewarm", async () => {
    const absent = createTranscriptClient(
      async <T>() => ({ kind: "absent" }) as T,
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
        loaded(args?.sessionId === otherScope.sessionId ? otherTranscript : transcript) as T,
      () => true,
    );

    await client.prewarm(scope);
    await client.prewarm(otherScope);

    expect(client.peek(scope)).toBeUndefined();
    expect(client.peek(otherScope)).toBe(otherTranscript);
  });
});

describe("transcript read normalization", () => {
  it("reads the tagged answer as it is", () => {
    expect(normalizeTranscriptRead({ kind: "absent" })).toEqual({ kind: "absent" });
    expect(normalizeTranscriptRead({ kind: "unchanged", revision: 7 })).toEqual({
      kind: "unchanged",
      revision: 7,
    });
    expect(normalizeTranscriptRead(loaded(transcript))).toEqual(loaded(transcript));
  });

  it("still shows a record from a shell that answers with the older untagged shape", () => {
    const legacy = {
      source: "claude",
      path: "session.jsonl",
      entries: [{ role: "assistant", text: "done", at: null }],
      totalEntries: 1,
      changedFiles: [],
      lastActivity: null,
    };

    const result = normalizeTranscriptRead(legacy);

    expect(result.kind).toBe("transcript");
    if (result.kind !== "transcript") return;
    expect(result.transcript.entries[0]).toEqual({
      role: "assistant",
      text: "done",
      at: null,
      tools: [],
      decisions: [],
    });
    expect(result.transcript.revision).toBe(0);
    expect(result.transcript.activity).toEqual({ state: "idle", lastTool: null, at: null });
    expect(result.transcript.usage).toBeNull();
    expect(normalizeTranscriptRead(null)).toEqual({ kind: "absent" });
  });
});
