import { describe, expect, it } from "vitest";
import type { Project, TerminalRuntimeStatus } from "../domain";
import { createWorkspaceSession } from "../sessionModel";
import {
  isAgentRecordNotice,
  runtimeAttentionNoticeKey,
  runtimeAttentionNotices,
  runtimeNoticeRank,
} from "./runtimeAttentionModel";

function projectWithStatus(
  status: TerminalRuntimeStatus | null,
  source: Project["source"] = "local",
): Project {
  return {
    id: "project-1",
    source,
    name: "Project",
    monogram: "P",
    color: "#000",
    path: "/project",
    branch: "—",
    description: "",
    launchProfile: { label: "Local shell", command: null, args: [] },
    sessions: [
      {
        ...createWorkspaceSession({
          id: "session-1",
          title: "Session 1",
          profile: "Local shell",
          launchProfile: { label: "Local shell", command: null, args: [] },
          branch: "—",
          createdAt: "2026-08-14T00:00:00.000Z",
          lastActivity: "Created",
          intro: null,
          outcome: "",
          nextStep: "",
          launchRequested: false,
        }),
        runtimeStatus: status,
      },
    ],
  };
}

function status(overrides: Partial<TerminalRuntimeStatus> = {}): TerminalRuntimeStatus {
  return {
    phase: "running",
    runId: 4,
    exitCode: null,
    termination: null,
    fault: null,
    observedAt: "2026-08-14T01:00:00.000Z",
    ...overrides,
  };
}

describe("runtime attention notices", () => {
  it.each(["starting", "running", "stopping"] as const)(
    "does not turn %s into an attention request",
    (phase) => {
      expect(runtimeAttentionNotices([projectWithStatus(status({ phase }))])).toEqual([]);
    },
  );

  it("does not re-alert an exit requested with the Talkak Stop control", () => {
    expect(
      runtimeAttentionNotices([
        projectWithStatus(
          status({ phase: "exited", exitCode: 143, termination: "requested-stop" }),
        ),
      ]),
    ).toEqual([]);
  });

  it("reports an observed exit with its exact code without calling it a success", () => {
    expect(
      runtimeAttentionNotices([
        projectWithStatus(status({ phase: "exited", exitCode: 0, termination: "observed-exit" })),
      ]),
    ).toEqual([
      {
        source: "local-pty",
        id: "runtime:session-1:4:exited",
        projectId: "project-1",
        sessionId: "session-1",
        observedAt: "2026-08-14T01:00:00.000Z",
        event: { kind: "exited", exitCode: 0 },
      },
    ]);
  });

  it("preserves the failing operation and raw error message", () => {
    const notices = runtimeAttentionNotices([
      projectWithStatus(
        status({
          phase: "running",
          fault: { operation: "write", message: "broken pipe" },
        }),
      ),
    ]);

    expect(notices[0]?.event).toEqual({
      kind: "error",
      fault: { operation: "write", message: "broken pipe" },
    });
  });

  it("uses the current run only, so a restart replaces the previous notice", () => {
    const first = runtimeAttentionNotices([
      projectWithStatus(status({ phase: "error", runId: 4 })),
    ]);
    const restarted = runtimeAttentionNotices([
      projectWithStatus(status({ phase: "error", runId: 5 })),
    ]);

    expect(first.map((notice) => notice.id)).toEqual(["runtime:session-1:4:error"]);
    expect(restarted.map((notice) => notice.id)).toEqual(["runtime:session-1:5:error"]);
  });

  it("gives a new same-run error observation a new acknowledgement key", () => {
    const first = runtimeAttentionNotices([
      projectWithStatus(status({ phase: "error", observedAt: "2026-08-14T01:00:00.000Z" })),
    ])[0];
    const repeated = runtimeAttentionNotices([
      projectWithStatus(status({ phase: "error", observedAt: "2026-08-14T01:05:00.000Z" })),
    ])[0];

    expect(first.id).toBe(repeated.id);
    expect(runtimeAttentionNoticeKey(first)).not.toBe(runtimeAttentionNoticeKey(repeated));
  });

  it("does not treat preview sessions as observed local PTYs", () => {
    expect(
      runtimeAttentionNotices([projectWithStatus(status({ phase: "error" }), "preview")]),
    ).toEqual([]);
  });
});

function projectWithAgent(
  runtimeStatus: TerminalRuntimeStatus,
  activity: {
    state: "idle" | "thinking" | "working" | "needs-input" | "done";
    lastTool?: string | null;
    at?: string | null;
  },
): Project {
  const project = projectWithStatus(runtimeStatus);
  return {
    ...project,
    sessions: project.sessions.map((session) => ({
      ...session,
      agentActivity: {
        state: activity.state,
        lastTool: activity.lastTool ?? null,
        at: activity.at ?? null,
      },
    })),
  };
}

describe("agent record notices", () => {
  it("turns a finished turn inside a live PTY into a turn-complete notice timed by the record", () => {
    expect(
      runtimeAttentionNotices([
        projectWithAgent(status(), {
          state: "done",
          lastTool: "Edit",
          at: "2026-08-14T01:05:00.000Z",
        }),
      ]),
    ).toEqual([
      {
        source: "local-pty",
        id: "runtime:session-1:4:turn-complete",
        projectId: "project-1",
        sessionId: "session-1",
        observedAt: "2026-08-14T01:05:00.000Z",
        event: { kind: "turn-complete", lastTool: "Edit" },
      },
    ]);
  });

  it("turns a pending question into a needs-input notice, falling back to the PTY time", () => {
    const notices = runtimeAttentionNotices([projectWithAgent(status(), { state: "needs-input" })]);
    expect(notices.map((notice) => [notice.event.kind, notice.observedAt])).toEqual([
      ["needs-input", "2026-08-14T01:00:00.000Z"],
    ]);
  });

  it.each(["idle", "thinking", "working"] as const)("does not alert on %s", (state) => {
    expect(runtimeAttentionNotices([projectWithAgent(status(), { state })])).toEqual([]);
  });

  it("never lets a record outlive its process: an exited PTY yields only the exit", () => {
    const notices = runtimeAttentionNotices([
      projectWithAgent(status({ phase: "exited", exitCode: 0, termination: "observed-exit" }), {
        state: "done",
      }),
    ]);
    expect(notices.map((notice) => notice.event.kind)).toEqual(["exited"]);
  });

  it("orders failures, then blocked agents, then exits, then finished replies", () => {
    const named = (id: string, project: Project): Project => ({
      ...project,
      id,
      sessions: project.sessions.map((session) => ({ ...session, id: `${id}-s` })),
    });
    const notices = runtimeAttentionNotices([
      named("a", projectWithAgent(status(), { state: "done" })),
      named(
        "b",
        projectWithStatus(status({ phase: "exited", exitCode: 1, termination: "observed-exit" })),
      ),
      named("c", projectWithAgent(status(), { state: "needs-input" })),
      named("d", projectWithStatus(status({ phase: "error" }))),
    ]);
    expect(notices.map((notice) => notice.event.kind)).toEqual([
      "error",
      "needs-input",
      "exited",
      "turn-complete",
    ]);
    expect(runtimeNoticeRank("error")).toBeLessThan(runtimeNoticeRank("turn-complete"));
    expect(notices.filter(isAgentRecordNotice).map((notice) => notice.event.kind)).toEqual([
      "needs-input",
      "turn-complete",
    ]);
  });
});
