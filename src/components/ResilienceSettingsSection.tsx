import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import {
  KNOWN_AGENTS,
  type ResilienceSettings,
  browserResilienceStorage,
  readResilienceSettings,
  writeResilienceSettings,
} from "../resilienceSettings";
import {
  type BrokerAutostartClient,
  type BrokerAutostartStatus,
  brokerAutostartClient,
} from "../runtime/brokerAutostart";
import { sessionClient } from "../runtime/sessionClient";

/**
 * Session recovery: whether the broker starts at login, and the per-agent resume command a
 * restored shell is handed. The toggle reflects what the OS side actually holds (the plist or
 * Run entry), not just the saved preference.
 */
export function ResilienceSettingsSection({
  client = brokerAutostartClient,
}: {
  client?: BrokerAutostartClient;
}) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<ResilienceSettings>(() =>
    readResilienceSettings(browserResilienceStorage()),
  );
  const [status, setStatus] = useState<BrokerAutostartStatus | null>(null);
  const [storeDir, setStoreDir] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!client.available()) return;
    let cancelled = false;
    void client
      .status()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client]);

  useEffect(() => {
    if (!sessionClient.available()) return;
    let cancelled = false;
    void sessionClient
      .storeDir()
      .then((dir) => {
        if (!cancelled) setStoreDir(dir);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = (next: ResilienceSettings) => {
    setSettings(next);
    writeResilienceSettings(browserResilienceStorage(), next);
  };

  const toggleAutostart = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const next = await client.set(enabled);
      setStatus(next);
      persist({ ...settings, brokerAutostart: next.enabled });
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const supported = status?.supported ?? false;
  const enabled = status?.enabled ?? settings.brokerAutostart;

  return (
    <section className="setting-card" aria-labelledby="resilience-title">
      <div className="setting-card__row">
        <div>
          <h3 id="resilience-title">{t("settings.resilience.title")}</h3>
          <p className="setting-card__description">{t("settings.resilience.description")}</p>
        </div>
      </div>
      <div className="setting-card__row">
        <label className="setting-toggle">
          <input
            type="checkbox"
            data-testid="broker-autostart"
            checked={enabled}
            disabled={busy || !client.available() || (status !== null && !supported)}
            onChange={(event) => void toggleAutostart(event.currentTarget.checked)}
          />
          <span>{t("settings.resilience.autostart")}</span>
        </label>
        <p className="setting-card__hint">
          {status !== null && !supported
            ? t("settings.resilience.autostartUnsupported")
            : t("settings.resilience.autostartHint")}
        </p>
        {status?.program ? (
          <p className="setting-card__hint">
            {t("settings.resilience.autostartProgram")}: <code>{status.program}</code>
          </p>
        ) : null}
        {error ? (
          <output className="setting-card__error">
            {t("settings.resilience.failed", { message: error })}
          </output>
        ) : null}
      </div>
      <div className="setting-card__row">
        <div>
          <h4>{t("settings.resilience.recipes")}</h4>
          <p className="setting-card__hint">{t("settings.resilience.recipesHint")}</p>
        </div>
        <div className="resilience-recipes">
          {KNOWN_AGENTS.map((agent) => (
            <label key={agent} className="resilience-recipe">
              <span>{agent}</span>
              <input
                type="text"
                data-testid={`resume-recipe-${agent}`}
                value={settings.recipes[agent] ?? ""}
                placeholder={t("settings.resilience.recipeOff")}
                spellCheck={false}
                onChange={(event) =>
                  persist({
                    ...settings,
                    recipes: { ...settings.recipes, [agent]: event.currentTarget.value },
                  })
                }
              />
            </label>
          ))}
        </div>
        {storeDir ? (
          <p className="setting-card__hint">
            {t("settings.resilience.storeDir")}: <code>{storeDir}</code>
          </p>
        ) : null}
      </div>
    </section>
  );
}
