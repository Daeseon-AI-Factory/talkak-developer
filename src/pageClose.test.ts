import { describe, expect, it } from "vitest";
import type { DevSession, TerminalRuntimeStatus } from "./domain";
import type { LayoutNode, WorkspacePage } from "./layoutModel";
import { pageCloseImpact, pageCloseNeedsConfirmation } from "./pageClose";

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

function split(first: LayoutNode, second: LayoutNode): LayoutNode {
  return { kind: "split", id: "split-1", direction: "horizontal", ratio: 0.5, first, second };
}

function page(root: LayoutNode | null): WorkspacePage {
  return { id: "page-1", title: { kind: "page-title", index: 1 }, root };
}

function index(...sessions: DevSession[]) {
  return new Map(sessions.map((entry) => [entry.id, entry]));
}

describe("what closing a page costs", () => {
  it("counts the panes and how many of them are still working", () => {
    const sessions = index(
      session("s1", status({ phase: "running" })),
      session("s2", status({ phase: "exited", exitCode: 0, termination: "observed-exit" })),
    );
    expect(pageCloseImpact(page(split(pane("p1", "s1"), pane("p2", "s2"))), sessions)).toEqual({
      paneCount: 2,
      runningCount: 1,
    });
  });

  it("does not count a pane whose session is already gone as running", () => {
    expect(pageCloseImpact(page(pane("p1", "missing")), index())).toEqual({
      paneCount: 1,
      runningCount: 0,
    });
  });

  it("treats a starting session as running, because it is about to be", () => {
    const sessions = index(session("s1", status({ phase: "starting" })));
    expect(pageCloseImpact(page(pane("p1", "s1")), sessions).runningCount).toBe(1);
  });
});

describe("when to ask", () => {
  it("asks whenever the page holds a pane, running or not — the layout is the thing being lost", () => {
    expect(pageCloseNeedsConfirmation({ paneCount: 1, runningCount: 0 })).toBe(true);
    expect(pageCloseNeedsConfirmation({ paneCount: 3, runningCount: 3 })).toBe(true);
  });

  it("does not interrupt for an empty page — a guard that always fires stops being read", () => {
    expect(pageCloseNeedsConfirmation({ paneCount: 0, runningCount: 0 })).toBe(false);
  });
});
