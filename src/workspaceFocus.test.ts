import { describe, expect, it } from "vitest";
import type { WorkspacePage } from "./layoutModel";
import { cycleFocusedPane, focusedPane } from "./workspaceFocus";

const page: WorkspacePage = {
  id: "page-1",
  title: "Page 1",
  root: {
    kind: "split",
    id: "split-1",
    direction: "horizontal",
    ratio: 0.5,
    first: { kind: "pane", id: "pane-1", sessionId: "session-1" },
    second: { kind: "pane", id: "pane-2", sessionId: "session-2" },
  },
};

describe("workspace focus", () => {
  it("restores a requested pane and falls back to the first pane", () => {
    expect(focusedPane(page, "pane-2")?.id).toBe("pane-2");
    expect(focusedPane(page, "missing")?.id).toBe("pane-1");
  });

  it("cycles pane focus in both directions", () => {
    expect(cycleFocusedPane(page, "pane-2", 1)?.id).toBe("pane-1");
    expect(cycleFocusedPane(page, "pane-1", -1)?.id).toBe("pane-2");
  });
});
