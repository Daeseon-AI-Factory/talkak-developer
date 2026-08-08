import type { DragEvent } from "react";
import { useI18n } from "../i18n";
import { type WorkspacePage, listPanes } from "../layoutModel";
import { Icon } from "./Icon";

const PANE_DRAG_TYPE = "application/x-talkak-pane";

interface PageTabsProps {
  pages: readonly WorkspacePage[];
  activePageId: string;
  onSelectPage: (pageId: string) => void;
  onCreatePage: () => void;
  onClosePage: (pageId: string) => void;
  onMovePaneToPage: (paneId: string, pageId: string) => void;
}

export function PageTabs({
  pages,
  activePageId,
  onSelectPage,
  onCreatePage,
  onClosePage,
  onMovePaneToPage,
}: PageTabsProps) {
  const { t } = useI18n();

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
        return (
          <div
            className="page-tab"
            data-active={active}
            key={page.id}
            onDragOver={allowPaneDrop}
            onDrop={(event) => movePane(event, page.id)}
          >
            <button
              className="page-tab__select"
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onSelectPage(page.id)}
            >
              <span>{page.title}</span>
              <small>{paneCount}</small>
            </button>
            {pages.length > 1 ? (
              <button
                className="page-tab__close"
                type="button"
                aria-label={t("pages.close", { page: page.title })}
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
        aria-label={t("pages.add")}
        title={t("pages.add")}
        onClick={onCreatePage}
      >
        <Icon name="plus" size={15} />
      </button>
    </div>
  );
}

export function writePaneDragData(event: DragEvent<HTMLElement>, paneId: string) {
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData(PANE_DRAG_TYPE, paneId);
}
