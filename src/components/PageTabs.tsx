import type { DragEvent } from "react";
import type { DevSession } from "../domain";
import { useI18n } from "../i18n";
import { type WorkspacePage, listPanes } from "../layoutModel";
import { pageActivity, pageSessionSummary } from "../pageActivity";
import { Icon } from "./Icon";

const PANE_DRAG_TYPE = "application/x-talkak-pane";

interface PageTabsProps {
  pages: readonly WorkspacePage[];
  activePageId: string;
  onSelectPage: (pageId: string) => void;
  onCreatePage: () => void;
  onClosePage: (pageId: string) => void;
  onMovePaneToPage: (paneId: string, pageId: string) => void;
  addShortcut: string;
  switchShortcut: string;
  /** Sessions of the active project, so a tab can say what its page is doing. */
  sessionsById: ReadonlyMap<string, DevSession>;
}

export function PageTabs({
  pages,
  activePageId,
  onSelectPage,
  onCreatePage,
  onClosePage,
  onMovePaneToPage,
  addShortcut,
  switchShortcut,
  sessionsById,
}: PageTabsProps) {
  const { t, text } = useI18n();

  function allowPaneDrop(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes(PANE_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }

  function movePane(event: DragEvent<HTMLDivElement>, pageId: string) {
    const paneId = event.dataTransfer.getData(PANE_DRAG_TYPE);
    if (!paneId) return;
    event.preventDefault();
    onMovePaneToPage(paneId, pageId);
  }

  return (
    <div className="page-tabs" role="tablist" aria-label={t("pages.tabsAria")}>
      {pages.map((page) => {
        const active = page.id === activePageId;
        const paneCount = listPanes(page.root).length;
        const pageTitle = text(page.title);
        const activity = pageActivity(page, sessionsById);
        const summary = pageSessionSummary(page, sessionsById, (session, sessionState) =>
          t("pages.sessionLine", {
            session: text(session.title),
            state: t(`pages.activity.${sessionState}`),
          }),
        );
        return (
          <div
            className="page-tab"
            data-active={active}
            data-activity={activity}
            key={page.id}
            onDragOver={allowPaneDrop}
            onDrop={(event) => movePane(event, page.id)}
          >
            <button
              className="page-tab__select"
              type="button"
              data-testid="page-tab"
              role="tab"
              aria-selected={active}
              // The toolbar no longer carries a standing hint — it never had room and was always
              // cut off. The keys live in the shortcut guide, and here on the thing they act on.
              title={[...summary, t("pages.switchHint", { shortcuts: switchShortcut })].join("\n")}
              onClick={() => onSelectPage(page.id)}
            >
              <span className="page-tab__activity" data-activity={activity} />
              <span>{pageTitle}</span>
              <small>{paneCount}</small>
            </button>
            {pages.length > 1 ? (
              <button
                className="page-tab__close"
                type="button"
                aria-label={t("pages.close", { page: pageTitle })}
                onClick={() => onClosePage(page.id)}
              >
                <Icon name="x" size={12} />
              </button>
            ) : null}
          </div>
        );
      })}
      <button
        className="page-tabs__add"
        type="button"
        data-testid="add-page"
        aria-label={t("pages.add")}
        title={`${t("pages.addDescription")} · ${addShortcut}`}
        onClick={onCreatePage}
      >
        <Icon name="plus" size={15} />
        <span>{t("pages.addVisible")}</span>
        <kbd>{addShortcut}</kbd>
      </button>
    </div>
  );
}

export function writePaneDragData(event: DragEvent<HTMLElement>, paneId: string) {
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData(PANE_DRAG_TYPE, paneId);
}
