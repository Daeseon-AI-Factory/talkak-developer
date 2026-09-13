import type { MessageKey } from "../i18n/strings";
import { liveSessionProgram, relativeAge } from "../runtime/liveSessionPresentation";
import type { LiveSession } from "../runtime/sessionClient";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

/** "3m ago" in the current language, or the `missing` phrase when there is no stamp to age. */
export function ageLabel(
  t: Translate,
  nowMs: number,
  thenMs: number | null | undefined,
  missing: MessageKey,
): string {
  if (thenMs === null || thenMs === undefined) return t(missing);
  const age = relativeAge(nowMs, thenMs);
  if (age.unit === "now") return t("age.now");
  return t(`age.${age.unit}`, { value: age.value });
}

/** The program a broker row shows; the OS default shell is named in the current language. */
export function programLabel(t: Translate, session: Pick<LiveSession, "command">): string {
  return liveSessionProgram(session) ?? t("terminal.localShell");
}
