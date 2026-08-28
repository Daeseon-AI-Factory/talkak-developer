import type { DevSession } from "./domain";
import { type WorkspacePage, listPanes } from "./layoutModel";

/**
 * What a page is doing, so a tab can say it without being opened.
 *
 * A page tab showed a title and a pane count and nothing else: whether a session on another page
 * had failed, finished, or was still working was invisible until you switched to it. That is the
 * whole point of having pages.
 */
export type PageActivity = "attention" | "running" | "exited" | "idle";

const RANK: Record<PageActivity, number> = { attention: 3, running: 2, exited: 1, idle: 0 };

/** The state of one session, from its observed runtime rather than its seeded label. */
export function sessionActivity(session: DevSession): PageActivity {
  const status = session.runtimeStatus;
  if (!status) return "idle";
  if (status.phase === "error" || status.fault) return "attention";
  if (status.phase === "exited") {
    // A process that died on its own with a non-zero code is a result someone needs to look at.
    // One the user stopped is not: Ctrl-C leaves 130, and flagging that would cry wolf every time.
    const failed =
      status.termination === "observed-exit" && status.exitCode !== null && status.exitCode !== 0;
    return failed ? "attention" : "exited";
  }
  if (status.phase === "running" || status.phase === "starting" || status.phase === "stopping") {
    return "running";
  }
  return "idle";
}

/** The most urgent thing happening on a page — what its tab should show. */
export function pageActivity(
  page: WorkspacePage,
  sessionsById: ReadonlyMap<string, DevSession>,
): PageActivity {
  let worst: PageActivity = "idle";
  for (const pane of listPanes(page.root)) {
    const session = sessionsById.get(pane.sessionId);
    if (!session) continue;
    const activity = sessionActivity(session);
    if (RANK[activity] > RANK[worst]) worst = activity;
  }
  return worst;
}

/** One line per session for the tab's tooltip: which sessions, and what each is doing. */
export function pageSessionSummary(
  page: WorkspacePage,
  sessionsById: ReadonlyMap<string, DevSession>,
  describe: (session: DevSession, activity: PageActivity) => string,
): string[] {
  return listPanes(page.root)
    .map((pane) => sessionsById.get(pane.sessionId))
    .filter((session): session is DevSession => session !== undefined)
    .map((session) => describe(session, sessionActivity(session)));
}
