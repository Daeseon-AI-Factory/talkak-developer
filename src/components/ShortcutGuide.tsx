import { useEffect, useRef } from "react";
import { useI18n } from "../i18n";
import type { DesktopPlatform } from "../platform";
import { SHORTCUTS, type ShortcutCommandId, shortcutDisplay } from "../shortcutRegistry";
import { Icon } from "./Icon";

export function ShortcutGuide({
  open,
  platform,
  onClose,
}: {
  open: boolean;
  platform: DesktopPlatform;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => closeRef.current?.focus());
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [onClose, open]);

  if (!open) return null;
  return (
    <div className="shortcut-guide-backdrop" role="presentation" onMouseDown={onClose}>
      <dialog
        open
        className="shortcut-guide"
        aria-modal="true"
        aria-label={t("shortcuts.title")}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          event.preventDefault();
          closeRef.current?.focus();
        }}
      >
        <header>
          <div>
            <span>{t("shortcuts.eyebrow")}</span>
            <h2>{t("shortcuts.title")}</h2>
            <p>{t("shortcuts.description")}</p>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label={t("shortcuts.close")}>
            <Icon name="x" size={17} />
          </button>
        </header>
        <div className="shortcut-guide__list">
          {SHORTCUTS.filter((definition) => !NUMBERED_SIBLING.test(definition.id)).map(
            (definition) => (
              <div key={definition.id}>
                <span>{t(shortcutLabelKey(definition.id))}</span>
                <kbd>
                  {definition.id === "focusPane1" || definition.id === "focusProject1"
                    ? // Nine sibling chords shown as one range row instead of nine rows.
                      `${shortcutDisplay(platform, definition.id)}…9`
                    : shortcutDisplay(platform, definition.id)}
                </kbd>
              </div>
            ),
          )}
        </div>
        <footer>{t("shortcuts.terminalSafe")}</footer>
      </dialog>
    </div>
  );
}

// The pane and project number chords: nine siblings each, shown as one range row.
const NUMBERED_SIBLING = /^focus(?:Pane|Project)[2-9]$/;

type GuideLabelKey = `shortcut.${Exclude<
  ShortcutCommandId,
  `focusPane${2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}` | `focusProject${2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
>}`;

// The nine chords of each number range share one translated label; only the first of each exists
// as a message key.
function shortcutLabelKey(id: ShortcutCommandId): GuideLabelKey {
  if (/^focusPane[2-9]$/.test(id)) return "shortcut.focusPane1";
  if (/^focusProject[2-9]$/.test(id)) return "shortcut.focusProject1";
  return `shortcut.${id}` as GuideLabelKey;
}
