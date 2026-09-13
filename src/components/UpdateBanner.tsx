import { useState } from "react";
import { useI18n } from "../i18n";
import { useAppUpdate } from "../runtime/useAppUpdate";

/**
 * A one-line strip above the workspace when a newer release is ready — install now, or dismiss
 * for this app run and find it again under Settings. It never appears for a failed check; that is
 * a Settings matter, not something to put in front of terminal work.
 */
export function UpdateBanner() {
  const { t } = useI18n();
  const { state, install } = useAppUpdate();
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);

  if (state.kind === "installing") {
    return (
      <output className="update-banner">
        <span>{t("settings.update.installing", { version: state.version })}</span>
      </output>
    );
  }
  if (state.kind !== "available" || dismissedVersion === state.version) return null;
  return (
    <output className="update-banner" data-testid="update-banner">
      <span>
        {t("settings.update.available", { version: state.version, current: state.currentVersion })}
      </span>
      <button className="button button--primary" type="button" onClick={() => void install()}>
        {t("settings.update.install", { version: state.version })}
      </button>
      <button className="button" type="button" onClick={() => setDismissedVersion(state.version)}>
        {t("settings.update.later")}
      </button>
    </output>
  );
}
