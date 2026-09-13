import type { WorkspacePage } from "../layoutModel";
import { layoutForPaneLimit, listPanes } from "../layoutModel";

export function foregroundTerminalSessionIds(
  pages: readonly WorkspacePage[],
  activePageId: string,
  activeSessionId: string | null,
  maxPaneCount?: number,
): string[] {
  const activePage = pages.find((page) => page.id === activePageId) ?? pages[0];
  if (!activePage) return [];
  const root = maxPaneCount
    ? layoutForPaneLimit(activePage.root, maxPaneCount, activeSessionId)
    : activePage.root;
  return listPanes(root).map((pane) => pane.sessionId);
}
