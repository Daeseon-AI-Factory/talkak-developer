import type { DevSession } from "./domain";
import { type WorkspacePage, listPanes } from "./layoutModel";
import { sessionActivity } from "./pageActivity";

/**
 * What closing a page actually costs.
 *
 * Closing a page does not stop anything: `closeWorkspacePage` drops the page from the layout and
 * leaves every session running in the broker. That is the feature — an agent keeps working — but it
 * is also how sessions go missing, because nothing on screen refers to them afterwards. So the
 * question the dialog has to answer is "how much am I about to lose sight of", not "what dies".
 */
export interface PageCloseImpact {
  paneCount: number;
  runningCount: number;
}

export function pageCloseImpact(
  page: WorkspacePage,
  sessionsById: ReadonlyMap<string, DevSession>,
): PageCloseImpact {
  const panes = listPanes(page.root);
  let runningCount = 0;
  for (const pane of panes) {
    const session = sessionsById.get(pane.sessionId);
    if (session && sessionActivity(session) === "running") runningCount += 1;
  }
  return { paneCount: panes.length, runningCount };
}

/**
 * A page with nothing on it is not worth a dialog — there is nothing to lose sight of, and a guard
 * that fires on every click is one people learn to dismiss without reading.
 */
export function pageCloseNeedsConfirmation(impact: PageCloseImpact): boolean {
  return impact.paneCount > 0;
}

/**
 * Detaching one pane is the same misclick with a smaller blast radius: the pane X sits inside the
 * pane header, the toolbar has its own Close, and a shortcut fires it with no pointer involved.
 * Only a session that is still working is worth stopping someone for — closing a finished pane is
 * ordinary tidying, and asking every time is how a dialog becomes something people click through.
 */
export function paneDetachNeedsConfirmation(session: DevSession | undefined): boolean {
  return session !== undefined && sessionActivity(session) === "running";
}
