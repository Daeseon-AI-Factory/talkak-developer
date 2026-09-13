import { describe, expect, it } from "vitest";
import type { WorkspacePage } from "../layoutModel";
import { foregroundTerminalSessionIds } from "./sessionVisibility";

const pages: WorkspacePage[] = [
  {
    id: "page-one",
    title: "One",
    root: {
      kind: "split",
      id: "split-one",
      direction: "horizontal",
      ratio: 0.5,
      first: { kind: "pane", id: "pane-a", sessionId: "session-a" },
      second: {
        kind: "split",
        id: "split-two",
        direction: "vertical",
        ratio: 0.5,
        first: { kind: "pane", id: "pane-b", sessionId: "session-b" },
        second: { kind: "pane", id: "pane-c", sessionId: "session-c" },
      },
    },
  },
  {
    id: "page-two",
    title: "Two",
    root: { kind: "pane", id: "pane-d", sessionId: "session-d" },
  },
];

describe("foreground terminal sessions", () => {
  it("returns only the active page sessions on desktop", () => {
    expect(foregroundTerminalSessionIds(pages, "page-two", "session-d")).toEqual(["session-d"]);
  });

  it("matches the tablet projection and keeps the active session visible", () => {
    expect(foregroundTerminalSessionIds(pages, "page-one", "session-c", 2)).toEqual([
      "session-a",
      "session-c",
    ]);
  });
});
