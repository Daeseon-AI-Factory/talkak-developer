import { useMemo, useState } from "react";
import type { DevSession, Project } from "./domain";
import { type WorkspacePage, listPanes } from "./layoutModel";
import {
  type PageCloseImpact,
  pageCloseImpact,
  pageCloseNeedsConfirmation,
  paneDetachNeedsConfirmation,
} from "./pageClose";

/**
 * The two confirmations that guard against losing track of a running session by accident: closing
 * a page (the X sits a misclick away from the tab that switches pages) and detaching a pane
 * (closing does not stop the session — it just stops anything on screen referring to it).
 */
export function useCloseConfirmations({
  activeProject,
  activePages,
  detachPane,
  closeWorkspacePage,
}: {
  activeProject: Project;
  activePages: readonly WorkspacePage[];
  detachPane: (paneId: string) => void;
  closeWorkspacePage: (pageId: string) => void;
}) {
  const sessionsById = useMemo(
    () => new Map(activeProject.sessions.map((session) => [session.id, session])),
    [activeProject.sessions],
  );

  const [pageToClose, setPageToClose] = useState<string | null>(null);
  const closingPage = activePages.find((page) => page.id === pageToClose) ?? null;
  const closingImpact: PageCloseImpact | null = closingPage
    ? pageCloseImpact(closingPage, sessionsById)
    : null;

  const [paneToDetach, setPaneToDetach] = useState<string | null>(null);
  const detachingSession = (() => {
    if (!paneToDetach) return null;
    for (const page of activePages) {
      const pane = listPanes(page.root).find((candidate) => candidate.id === paneToDetach);
      if (pane) return sessionsById.get(pane.sessionId) ?? null;
    }
    return null;
  })();

  function requestDetachPane(paneId: string) {
    let session: DevSession | undefined;
    for (const page of activePages) {
      const pane = listPanes(page.root).find((candidate) => candidate.id === paneId);
      if (pane) {
        session = sessionsById.get(pane.sessionId);
        break;
      }
    }
    if (!paneDetachNeedsConfirmation(session)) {
      detachPane(paneId);
      return;
    }
    setPaneToDetach(paneId);
  }

  function requestClosePage(pageId: string) {
    const page = activePages.find((candidate) => candidate.id === pageId);
    if (!page) return;
    if (!pageCloseNeedsConfirmation(pageCloseImpact(page, sessionsById))) {
      closeWorkspacePage(pageId);
      return;
    }
    setPageToClose(pageId);
  }

  return {
    sessionsById,
    pageToClose,
    closingPage,
    closingImpact,
    paneToDetach,
    detachingSession,
    requestDetachPane,
    requestClosePage,
    cancelDetach: () => setPaneToDetach(null),
    confirmDetach: () => {
      if (paneToDetach) detachPane(paneToDetach);
      setPaneToDetach(null);
    },
    cancelClose: () => setPageToClose(null),
    confirmClose: () => {
      if (pageToClose) closeWorkspacePage(pageToClose);
      setPageToClose(null);
    },
  };
}
