import { describe, expect, it } from "vitest";
import {
  type LayoutNode,
  createPage,
  layoutForPaneLimit,
  listPanes,
  movePane,
  removePane,
  splitPane,
  updateSplitRatio,
} from "./layoutModel";

function singlePane(): LayoutNode {
  const root = createPage({
    pageId: "page-1",
    title: "Build",
    paneId: "pane-a",
    sessionId: "session-a",
  }).root;

  if (root === null) throw new Error("Expected createPage to create a root pane");
  return root;
}

describe("layout model", () => {
  it("creates a page with one session-backed pane", () => {
    const page = createPage({
      pageId: "page-1",
      title: "Build",
      paneId: "pane-a",
      sessionId: "session-a",
    });

    expect(page).toEqual({
      id: "page-1",
      title: "Build",
      root: { kind: "pane", id: "pane-a", sessionId: "session-a" },
    });
    expect(listPanes(page.root).map((pane) => pane.id)).toEqual(["pane-a"]);
  });

  it("projects a tablet-sized tree without mutating or hiding the active session", () => {
    const twoPanes = splitPane(singlePane(), "pane-a", {
      splitId: "split-root",
      paneId: "pane-b",
      sessionId: "session-b",
      direction: "horizontal",
    });
    const root = splitPane(twoPanes, "pane-b", {
      splitId: "split-nested",
      paneId: "pane-c",
      sessionId: "session-c",
      direction: "vertical",
    });
    const projected = layoutForPaneLimit(root, 2, "session-c");

    expect(listPanes(projected).map((pane) => pane.sessionId)).toEqual(["session-a", "session-c"]);
    expect(listPanes(root).map((pane) => pane.sessionId)).toEqual([
      "session-a",
      "session-b",
      "session-c",
    ]);
  });

  it("splits a target pane and preserves visual pane order", () => {
    const root = splitPane(singlePane(), "pane-a", {
      splitId: "split-root",
      paneId: "pane-b",
      sessionId: "session-b",
      direction: "horizontal",
      ratio: 0.6,
      placement: "before",
    });

    expect(root).toMatchObject({
      kind: "split",
      id: "split-root",
      direction: "horizontal",
      ratio: 0.6,
    });
    expect(listPanes(root).map((pane) => pane.id)).toEqual(["pane-b", "pane-a"]);
  });

  it("removes a pane and collapses its now-redundant parent split", () => {
    const split = splitPane(singlePane(), "pane-a", {
      splitId: "split-root",
      paneId: "pane-b",
      sessionId: "session-b",
      direction: "vertical",
    });
    const nested = splitPane(split, "pane-b", {
      splitId: "split-nested",
      paneId: "pane-c",
      sessionId: "session-c",
      direction: "horizontal",
    });

    const collapsed = removePane(nested, "pane-b");

    expect(listPanes(collapsed).map((pane) => pane.id)).toEqual(["pane-a", "pane-c"]);
    expect(collapsed).toMatchObject({
      kind: "split",
      id: "split-root",
      second: { kind: "pane", id: "pane-c" },
    });
  });

  it("updates only the requested split ratio", () => {
    const root = splitPane(singlePane(), "pane-a", {
      splitId: "split-root",
      paneId: "pane-b",
      sessionId: "session-b",
      direction: "horizontal",
    });

    const resized = updateSplitRatio(root, "split-root", 0.72);

    expect(resized).toMatchObject({ kind: "split", id: "split-root", ratio: 0.72 });
    expect(updateSplitRatio(resized, "missing", 0.4)).toBe(resized);
    expect(() => updateSplitRatio(resized, "split-root", 1)).toThrow(RangeError);
  });

  it("moves an existing pane by removing, collapsing, and reinserting it", () => {
    const split = splitPane(singlePane(), "pane-a", {
      splitId: "split-root",
      paneId: "pane-b",
      sessionId: "session-b",
      direction: "horizontal",
    });
    const nested = splitPane(split, "pane-a", {
      splitId: "split-left",
      paneId: "pane-c",
      sessionId: "session-c",
      direction: "vertical",
    });

    const moved = movePane(nested, "pane-c", "pane-b", {
      splitId: "split-moved",
      direction: "vertical",
      placement: "before",
    });

    expect(listPanes(moved).map((pane) => pane.id)).toEqual(["pane-a", "pane-c", "pane-b"]);
    expect(moved).toMatchObject({
      kind: "split",
      id: "split-root",
      first: { kind: "pane", id: "pane-a" },
      second: {
        kind: "split",
        id: "split-moved",
        direction: "vertical",
        first: { kind: "pane", id: "pane-c", sessionId: "session-c" },
        second: { kind: "pane", id: "pane-b" },
      },
    });
  });

  it("leaves the tree unchanged when a requested pane is missing", () => {
    const root = singlePane();

    expect(removePane(root, "missing")).toBe(root);
    expect(
      splitPane(root, "missing", {
        splitId: "unused",
        paneId: "pane-b",
        sessionId: "session-b",
        direction: "horizontal",
      }),
    ).toBe(root);
    expect(
      movePane(root, "missing", "pane-a", {
        splitId: "unused",
        direction: "horizontal",
      }),
    ).toBe(root);
  });
});
