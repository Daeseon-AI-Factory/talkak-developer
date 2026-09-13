import type { PaneNode, WorkspacePage } from "./layoutModel";
import { listPanes } from "./layoutModel";

export function focusedPane(
  page: WorkspacePage | undefined,
  requestedPaneId: string | null | undefined,
): PaneNode | null {
  const panes = listPanes(page?.root ?? null);
  return panes.find((pane) => pane.id === requestedPaneId) ?? panes[0] ?? null;
}

export function cycleFocusedPane(
  page: WorkspacePage | undefined,
  requestedPaneId: string | null | undefined,
  direction: -1 | 1,
): PaneNode | null {
  const panes = listPanes(page?.root ?? null);
  if (panes.length === 0) return null;
  const currentIndex = panes.findIndex((pane) => pane.id === requestedPaneId);
  const base = currentIndex >= 0 ? currentIndex : 0;
  return panes[(base + direction + panes.length) % panes.length];
}
