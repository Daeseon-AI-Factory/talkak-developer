import { useI18n } from "../i18n";
import type { AppUpdateState } from "../runtime/appUpdate";
import { useAppUpdate } from "../runtime/useAppUpdate";

/**
 * Where the app says which version it is, whether a newer one exists, and lets the person install
 * it. Every state the updater can be in has its own sentence; "checking" and "failed" are shown as
 * themselves, never as "up to date".
 */
export function UpdateSettingsSection() {
  const { t } = useI18n();
  const { state, check, install } = useAppUpdate();
  const busy = state.kind === "checking" || state.kind === "installing";

  return (
    <section className="setting-card update-card" aria-labelledby="update-title">
      <div className="setting-card__row">
        <div>
          <h3 id="update-title">{t("settings.update")}</h3>
          <p>{updateStatusText(state, t)}</p>
        </div>
        <div className="update-card__actions">
          {state.kind === "available" ? (
            <button className="button button--primary" type="button" onClick={() => void install()}>
              {t("settings.update.install", { version: state.version })}
            </button>
          ) : null}
          {state.kind !== "unsupported" && state.kind !== "installed" ? (
            <button className="button" type="button" disabled={busy} onClick={() => void check()}>
              {t("settings.update.check")}
            </button>
          ) : null}
        </div>
      </div>
      {state.kind === "available" && state.notes ? (
        <pre className="update-card__notes">{state.notes}</pre>
      ) : null}
      {state.kind === "installing" ? (
        <progress
          className="update-card__progress"
          value={state.totalBytes ? state.downloadedBytes : undefined}
          max={state.totalBytes ?? undefined}
          aria-label={t("settings.update.installing", { version: state.version })}
        />
      ) : null}
    </section>
  );
}

export function updateStatusText(
  state: AppUpdateState,
  t: ReturnType<typeof useI18n>["t"],
): string {
  switch (state.kind) {
    case "unsupported":
      return t("settings.update.unsupported");
    case "idle":
      return state.currentVersion
        ? t("settings.update.idle", { version: state.currentVersion })
        : t("settings.update.idleUnknown");
    case "checking":
      return t("settings.update.checking");
    case "current":
      return t("settings.update.current", {
        version: state.currentVersion,
        time: new Date(state.checkedAt).toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
        }),
      });
    case "available":
      return t("settings.update.available", {
        version: state.version,
        current: state.currentVersion,
      });
    case "installing":
      return t("settings.update.installing", { version: state.version });
    case "installed":
      return t("settings.update.installed", { version: state.version });
    case "failed":
      return t("settings.update.failed", { message: state.message });
  }
}
