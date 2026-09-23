import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentActivity, Project, TerminalRuntimeStatus } from "../domain";
import { createWorkspaceSession } from "../sessionModel";
import {
  agentActivityTargets,
  agentRecordIdleMinutes,
  agentRecordLooksStale,
  createAgentActivityClient,
  startAgentActivityPolling,
} from "./agentActivity";

function status(overrides: Partial<TerminalRuntimeStatus> = {}): TerminalRuntimeStatus {
  return {
    phase: "running",
    runId: 4,
    exitCode: null,
    termination: null,
    fault: null,
    observedAt: "2026-09-01T01:00:00.000Z",
    ...overrides,
  };
}

function project(
  sessions: Array<{ id: string; status: TerminalRuntimeStatus | null; command?: string | null }>,
  source: Project["source"] = "local",
): Project {
  return {
    id: "project-1",
    source,
    name: "Project",
    monogram: "P",
    color: "#000",
    path: "/project",
    branch: "main",
    description: "",
    launchProfile: { label: "Agent", command: "agent", args: [] },
    sessions: sessions.map(({ id, status, command = "agent" }) => ({
      ...createWorkspaceSession({
        id,
        title: id,
        profile: "Agent",
        launchProfile: { label: "Agent", command, args: [] },
        branch: "main",
        createdAt: "2026-09-01T00:00:00.000Z",
        lastActivity: "Created",
        intro: null,
        outcome: "",
        nextStep: "",
        launchRequested: false,
      }),
      runtimeStatus: status,
    })),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("agent activity client", () => {
  it("calls agent_activity with the transcript scope and no limit", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const client = createAgentActivityClient(
      async <T>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        return { activity: { state: "done", lastTool: null, at: null }, revision: 3 } as T;
      },
      () => true,
    );

    const report = await client.read({
      sessionId: "session-1",
      runId: 4,
      projectPath: "/project",
      startedAt: "2026-09-01T00:00:00.000Z",
      agentCommand: "agent",
    });

    expect(calls).toEqual([
      {
        command: "agent_activity",
        args: {
          sessionId: "session-1",
          runId: 4,
          projectPath: "/project",
          startedAt: "2026-09-01T00:00:00.000Z",
          agentCommand: "agent",
        },
      },
    ]);
    expect(report?.revision).toBe(3);
  });
});

describe("which sessions get polled", () => {
  it("polls only live PTYs in local projects, with the session's own transcript scope", () => {
    const targets = agentActivityTargets([
      project([
        { id: "running", status: status({ phase: "running" }) },
        { id: "stopping", status: status({ phase: "stopping", runId: 5 }) },
        { id: "starting", status: status({ phase: "starting" }) },
        { id: "exited", status: status({ phase: "exited", exitCode: 0 }) },
        { id: "never", status: null },
      ]),
      { ...project([{ id: "preview", status: status() }], "preview"), id: "project-2" },
    ]);

    expect(targets).toEqual([
      {
        projectId: "project-1",
        scope: {
          sessionId: "running",
          runId: 4,
          projectPath: "/project",
          startedAt: "2026-09-01T00:00:00.000Z",
          agentCommand: "agent",
        },
      },
      {
        projectId: "project-1",
        scope: {
          sessionId: "stopping",
          runId: 5,
          projectPath: "/project",
          startedAt: "2026-09-01T00:00:00.000Z",
          agentCommand: "agent",
        },
      },
    ]);
  });

  it("keeps a plain shell in the list: the record decides whether an agent ran, not the profile", () => {
    const targets = agentActivityTargets([
      project([{ id: "shell", status: status(), command: null }]),
    ]);
    expect(targets.map((target) => target.scope.agentCommand)).toEqual([null]);
  });
});

describe("the poll loop", () => {
  it("reads immediately, then again only after the previous read settles", async () => {
    vi.useFakeTimers();
    let resolveRead: (() => void) | undefined;
    const read = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const stop = startAgentActivityPolling(read, 1000);

    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(1);

    resolveRead?.();
    await vi.advanceTimersByTimeAsync(999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    stop();
  });

  it("keeps going after a failed read and stops cleanly when told to", async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => {
      throw new Error("broker hiccup");
    });
    const stop = startAgentActivityPolling(read, 1000);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe("the agent-gone hint", () => {
  const now = Date.parse("2026-09-01T01:00:00.000Z");
  const activity = (state: AgentActivity["state"], minutesAgo: number | null): AgentActivity => ({
    state,
    lastTool: null,
    at: minutesAgo === null ? null : new Date(now - minutesAgo * 60_000).toISOString(),
  });

  it("flags a mid-turn record that has gone quiet for the threshold", () => {
    expect(agentRecordLooksStale(activity("thinking", 10), now)).toBe(true);
    expect(agentRecordLooksStale(activity("working", 45), now)).toBe(true);
    expect(agentRecordIdleMinutes(activity("working", 45), now)).toBe(45);
  });

  it("stays quiet while the agent is still within the threshold", () => {
    expect(agentRecordLooksStale(activity("thinking", 9), now)).toBe(false);
    expect(agentRecordLooksStale(activity("working", 0), now)).toBe(false);
  });

  it("never calls a finished turn or a pending question stale — those can wait for hours", () => {
    expect(agentRecordLooksStale(activity("done", 180), now)).toBe(false);
    expect(agentRecordLooksStale(activity("needs-input", 180), now)).toBe(false);
    expect(agentRecordLooksStale(activity("idle", 180), now)).toBe(false);
  });

  it("cannot judge a record without a time, and says nothing rather than guessing", () => {
    expect(agentRecordLooksStale(activity("working", null), now)).toBe(false);
    expect(agentRecordIdleMinutes(activity("working", null), now)).toBeNull();
    expect(agentRecordLooksStale(null, now)).toBe(false);
  });
});
