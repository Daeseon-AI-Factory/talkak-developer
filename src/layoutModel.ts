export type SplitDirection = "horizontal" | "vertical";

export type PanePlacement = "before" | "after";

export interface PaneNode {
  kind: "pane";
  id: string;
  sessionId: string;
}

export interface SplitNode {
  kind: "split";
  id: string;
  /** horizontal = left/right, vertical = top/bottom */
  direction: SplitDirection;
  /** Portion of the available space assigned to the first child. */
  ratio: number;
  first: LayoutNode;
  second: LayoutNode;
}

export type LayoutNode = PaneNode | SplitNode;

export interface WorkspacePage {
  id: string;
  title: string;
  root: LayoutNode | null;
}

export interface CreatePageInput {
  pageId: string;
  title: string;
  paneId: string;
  sessionId: string;
}

export interface SplitPaneInput {
  splitId: string;
  paneId: string;
  sessionId: string;
  direction: SplitDirection;
  ratio?: number;
  placement?: PanePlacement;
}

export interface MovePaneInput {
  splitId: string;
  direction: SplitDirection;
  ratio?: number;
  placement?: PanePlacement;
}

const DEFAULT_SPLIT_RATIO = 0.5;

export function createPage(input: CreatePageInput): WorkspacePage {
  return {
    id: input.pageId,
    title: input.title,
    root: {
      kind: "pane",
      id: input.paneId,
      sessionId: input.sessionId,
    },
  };
}

export function listPanes(root: LayoutNode | null): PaneNode[] {
  if (root === null) return [];
  if (root.kind === "pane") return [root];
  return [...listPanes(root.first), ...listPanes(root.second)];
}

/**
 * Creates a read-only presentation tree without mutating the persisted layout.
 * The active session remains visible when the viewport cannot show every pane.
 */
export function layoutForPaneLimit(
  root: LayoutNode | null,
  maxPaneCount: number,
  activeSessionId: string | null,
): LayoutNode | null {
  if (!Number.isInteger(maxPaneCount) || maxPaneCount < 1) {
    throw new RangeError("Pane limit must be a positive integer.");
  }
  const panes = listPanes(root);
  if (panes.length <= maxPaneCount) return root;

  const visible = panes.slice(0, maxPaneCount);
  const activePane = panes.find((pane) => pane.sessionId === activeSessionId);
  if (activePane && !visible.some((pane) => pane.id === activePane.id)) {
    visible[visible.length - 1] = activePane;
  }

  return visible.slice(1).reduce<LayoutNode>(
    (current, pane, index) => ({
      kind: "split",
      id: `presentation-split-${index}-${current.id}-${pane.id}`,
      direction: "horizontal",
      ratio: DEFAULT_SPLIT_RATIO,
      first: current,
      second: pane,
    }),
    visible[0],
  );
}

export function splitPane(
  root: LayoutNode | null,
  targetPaneId: string,
  input: SplitPaneInput,
): LayoutNode | null {
  const pane: PaneNode = {
    kind: "pane",
    id: input.paneId,
    sessionId: input.sessionId,
  };

  return insertPane(root, targetPaneId, pane, input);
}

export function removePane(root: LayoutNode | null, paneId: string): LayoutNode | null {
  if (root === null) return null;
  if (root.kind === "pane") return root.id === paneId ? null : root;

  const first = removePane(root.first, paneId);
  if (first === null) return root.second;
  if (first !== root.first) return { ...root, first };

  const second = removePane(root.second, paneId);
  if (second === null) return root.first;
  if (second !== root.second) return { ...root, second };

  return root;
}

export function updateSplitRatio(
  root: LayoutNode | null,
  splitId: string,
  ratio: number,
): LayoutNode | null {
  assertRatio(ratio);
  if (root === null || root.kind === "pane") return root;
  if (root.id === splitId) return root.ratio === ratio ? root : { ...root, ratio };

  const first = updateSplitRatio(root.first, splitId, ratio);
  if (first !== root.first) return { ...root, first: first ?? root.first };

  const second = updateSplitRatio(root.second, splitId, ratio);
  return second === root.second ? root : { ...root, second: second ?? root.second };
}

export function movePane(
  root: LayoutNode | null,
  paneId: string,
  targetPaneId: string,
  input: MovePaneInput,
): LayoutNode | null {
  if (root === null || paneId === targetPaneId) return root;

  const pane = findPane(root, paneId);
  if (pane === null || findPane(root, targetPaneId) === null) return root;

  const withoutPane = removePane(root, paneId);
  if (withoutPane === null || findPane(withoutPane, targetPaneId) === null) return root;

  return insertPane(withoutPane, targetPaneId, pane, input);
}

function insertPane(
  root: LayoutNode | null,
  targetPaneId: string,
  pane: PaneNode,
  input: MovePaneInput,
): LayoutNode | null {
  if (root === null) return null;

  if (root.kind === "pane") {
    if (root.id !== targetPaneId) return root;

    const ratio = input.ratio ?? DEFAULT_SPLIT_RATIO;
    assertRatio(ratio);
    const placement = input.placement ?? "after";

    return {
      kind: "split",
      id: input.splitId,
      direction: input.direction,
      ratio,
      first: placement === "before" ? pane : root,
      second: placement === "before" ? root : pane,
    };
  }

  const first = insertPane(root.first, targetPaneId, pane, input);
  if (first !== root.first) return { ...root, first: first ?? root.first };

  const second = insertPane(root.second, targetPaneId, pane, input);
  return second === root.second ? root : { ...root, second: second ?? root.second };
}

function findPane(root: LayoutNode, paneId: string): PaneNode | null {
  if (root.kind === "pane") return root.id === paneId ? root : null;
  return findPane(root.first, paneId) ?? findPane(root.second, paneId);
}

function assertRatio(ratio: number): void {
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) {
    throw new RangeError("Split ratio must be a finite number between 0 and 1.");
  }
}
