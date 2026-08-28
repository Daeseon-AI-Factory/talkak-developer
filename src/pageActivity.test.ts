import { describe, expect, it } from "vitest";
import type { DevSession, TerminalRuntimeStatus } from "./domain";
import type { LayoutNode, WorkspacePage } from "./layoutModel";
import { pageActivity, pageSessionSummary, sessionActivity } from "./pageActivity";

function status(patch: Partial<TerminalRuntimeStatus>): TerminalRuntimeStatus {
  return {
    phase: "idle",
    runId: 1,
    exitCode: null,
    termination: null,
    fault: null,
    observedAt: "2026-08-28T00:00:00.000Z",
    ...patch,
  };
}

function session(id: string, runtimeStatus?: TerminalRuntimeStatus | null): DevSession {
  return { id, title: { kind: "session-title", index: 1 }, runtimeStatus } as unknown as DevSession;
}

function pane(id: string, sessionId: string): LayoutNode {
  return { kind: "pane", id, sessionId };
}

function page(root: LayoutNode | null): WorkspacePage {
  return { id: "page-1", title: { kind: "page-title", index: 1 }, root };
}

function index(...sessions: DevSession[]) {
  return new Map(sessions.map((entry) => [entry.id, entry]));
}

describe("what one session is doing", () => {
  it("treats a session with no observation as idle rather than guessing", () => {
    expect(sessionActivity(session("s1"))).toBe("idle");
    expect(sessionActivity(session("s1", null))).toBe("idle");
  });

  it("counts starting and stopping as running, because both are the shell being busy", () => {
    for (const phase of ["starting", "running", "stopping"] as const) {
      expect(sessionActivity(session("s1", status({ phase })))).toBe("running");
    }
  });

  it("raises attention for an error phase and for a recorded fault", () => {
    expect(sessionActivity(session("s1", status({ phase: "error" })))).toBe("attention");
    expect(
      sessionActivity(
        session("s1", status({ phase: "idle", fault: { operation: "read", message: "pipe" } })),
      ),
    ).toBe("attention");
  });

  it("raises attention when a process died on its own with a non-zero code", () => {
    const observed = status({ phase: "exited", exitCode: 1, termination: "observed-exit" });
    expect(sessionActivity(session("s1", observed))).toBe("attention");
  });

  it("stays quiet for a clean exit and for one the user asked for", () => {
    const clean = status({ phase: "exited", exitCode: 0, termination: "observed-exit" });
    // Ctrl-C leaves 130. Flagging a stop the user requested would cry wolf every time.
    const requested = status({ phase: "exited", exitCode: 130, termination: "requested-stop" });
    expect(sessionActivity(session("s1", clean))).toBe("exited");
    expect(sessionActivity(session("s1", requested))).toBe("exited");
  });
});

describe("what a page is doing", () => {
  it("reports the most urgent session, so a failure is never hidden behind a busy one", () => {
    const root: LayoutNode = {
      kind: "split",
      id: "split-1",
      direction: "horizontal",
      ratio: 0.5,
      first: pane("p1", "s1"),
      second: pane("p2", "s2"),
    };
    const sessions = index(
      session("s1", status({ phase: "running" })),
      session("s2", status({ phase: "error" })),
    );
    expect(pageActivity(page(root), sessions)).toBe("attention");
  });

  it("prefers running over a finished sibling", () => {
    const root: LayoutNode = {
      kind: "split",
      id: "split-1",
      direction: "vertical",
      ratio: 0.5,
      first: pane("p1", "s1"),
      second: pane("p2", "s2"),
    };
    const sessions = index(
      session("s1", status({ phase: "exited", exitCode: 0, termination: "observed-exit" })),
      session("s2", status({ phase: "running" })),
    );
    expect(pageActivity(page(root), sessions)).toBe("running");
  });

  it("is idle for an empty page and skips panes whose session is gone", () => {
    expect(pageActivity(page(null), index())).toBe("idle");
    expect(pageActivity(page(pane("p1", "missing")), index())).toBe("idle");
  });
});

describe("the tab tooltip", () => {
  it("names every session on the page with its state", () => {
    const root: LayoutNode = {
      kind: "split",
      id: "split-1",
      direction: "horizontal",
      ratio: 0.5,
      first: pane("p1", "s1"),
      second: pane("p2", "s2"),
    };
    const sessions = index(
      session("s1", status({ phase: "running" })),
      session("s2", status({ phase: "error" })),
    );
    const lines = pageSessionSummary(
      page(root),
      sessions,
      (entry, activity) => `${entry.id}:${activity}`,
    );
    expect(lines).toEqual(["s1:running", "s2:attention"]);
  });

  it("leaves out panes with no session instead of printing a blank line", () => {
    expect(pageSessionSummary(page(pane("p1", "missing")), index(), () => "x")).toEqual([]);
  });
});
