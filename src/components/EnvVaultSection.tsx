import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../i18n";
import {
  type EnvVaultClient,
  type VaultListing,
  type VaultScope,
  envVaultClient,
  isValidVariableName,
} from "../runtime/envVaultClient";

interface EnvVaultSectionProps {
  /** The active local project's path, or null when the active project is a preview. */
  projectPath: string | null;
  projectName: string;
  client?: EnvVaultClient;
}

/**
 * Keys and values every session receives as environment variables: app-wide, or for the current
 * project. Secrets show as present, never as text. Nothing here is sent to an agent as a prompt;
 * it arrives the way any program expects — in `env`, with `TALKAK_ENV_KEYS` naming what is there.
 */
export function EnvVaultSection({
  projectPath,
  projectName,
  client = envVaultClient,
}: EnvVaultSectionProps) {
  const { t } = useI18n();
  const [scope, setScope] = useState<VaultScope>("app");
  const [entries, setEntries] = useState<VaultListing[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [secret, setSecret] = useState(true);
  const [dotenv, setDotenv] = useState("");
  const available = client.available();
  const projectScopeUsable = projectPath !== null;
  const effectiveScope: VaultScope = scope === "project" && !projectScopeUsable ? "app" : scope;

  const reload = useCallback(async () => {
    if (!available) return;
    try {
      setEntries(await client.list(effectiveScope, projectPath));
      setError(null);
    } catch (cause: unknown) {
      setError(describe(cause));
    }
  }, [available, client, effectiveScope, projectPath]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (action: () => Promise<string | null>) => {
    try {
      const message = await action();
      setNotice(message);
      setError(null);
      await reload();
    } catch (cause: unknown) {
      setError(describe(cause));
    }
  };

  const add = () =>
    run(async () => {
      const name = key.trim();
      if (!isValidVariableName(name)) throw new Error(t("settings.env.invalidName", { name }));
      await client.set(effectiveScope, projectPath, name, value, secret);
      setKey("");
      setValue("");
      return t("settings.env.saved", { name });
    });

  const importText = () =>
    run(async () => {
      const count = await client.importDotenv(effectiveScope, projectPath, dotenv, secret);
      setDotenv("");
      return t("settings.env.imported", { count });
    });

  return (
    <section className="setting-card env-vault" aria-labelledby="env-vault-title">
      <div className="setting-card__row">
        <div>
          <h3 id="env-vault-title">{t("settings.env")}</h3>
          <p>{t("settings.env.hint")}</p>
        </div>
      </div>
      {!available ? <p className="settings-note">{t("settings.env.unavailable")}</p> : null}
      <div className="settings-scope env-vault__scope" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={effectiveScope === "app"}
          data-active={effectiveScope === "app"}
          onClick={() => setScope("app")}
        >
          {t("settings.scope.app")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={effectiveScope === "project"}
          data-active={effectiveScope === "project"}
          disabled={!projectScopeUsable}
          title={projectScopeUsable ? projectName : t("settings.env.noLocalProject")}
          onClick={() => setScope("project")}
        >
          {t("settings.env.scopeProject", { project: projectName })}
        </button>
      </div>
      <ul className="env-vault__list">
        {entries.length === 0 ? (
          <li className="env-vault__empty">{t("settings.env.empty")}</li>
        ) : null}
        {entries.map((entry) => (
          <li className="env-vault__entry" key={entry.key}>
            <code className="env-vault__key">{entry.key}</code>
            <span className="env-vault__value">
              {entry.secret ? (
                <span className="env-vault__secret">{t("settings.env.secretValue")}</span>
              ) : (
                <code>{entry.value}</code>
              )}
            </span>
            <button
              type="button"
              className="button button--small"
              onClick={() =>
                run(async () => {
                  await client.delete(effectiveScope, projectPath, entry.key);
                  return t("settings.env.removed", { name: entry.key });
                })
              }
            >
              {t("settings.env.remove")}
            </button>
          </li>
        ))}
      </ul>
      <form
        className="env-vault__form"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <input
          aria-label={t("settings.env.name")}
          placeholder="API_TOKEN"
          value={key}
          onChange={(event) => setKey(event.currentTarget.value)}
          disabled={!available}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <input
          aria-label={t("settings.env.value")}
          placeholder={t("settings.env.valuePlaceholder")}
          type={secret ? "password" : "text"}
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
          disabled={!available}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <label className="env-vault__secret-toggle">
          <input
            type="checkbox"
            checked={secret}
            onChange={(event) => setSecret(event.currentTarget.checked)}
          />
          {t("settings.env.markSecret")}
        </label>
        <button className="button button--primary" type="submit" disabled={!available || !key}>
          {t("settings.env.add")}
        </button>
      </form>
      <details className="env-vault__import">
        <summary>{t("settings.env.import")}</summary>
        <textarea
          aria-label={t("settings.env.import")}
          placeholder={"API_TOKEN=...\nREGISTRY_URL=https://..."}
          value={dotenv}
          onChange={(event) => setDotenv(event.currentTarget.value)}
          rows={4}
          disabled={!available}
          spellCheck={false}
        />
        <button
          className="button"
          type="button"
          disabled={!available || !dotenv.trim()}
          onClick={() => void importText()}
        >
          {t("settings.env.importButton")}
        </button>
      </details>
      {notice ? <output className="settings-note">{notice}</output> : null}
      {error ? (
        <output className="settings-note" data-tone="danger">
          {error}
        </output>
      ) : null}
    </section>
  );
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
