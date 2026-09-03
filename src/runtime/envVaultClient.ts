import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * The environment vault, as the renderer sees it: names, whether each is secret, and the plain
 * values only. A secret's value never crosses this boundary; it goes from the OS credential store
 * straight into a session's environment on the native side.
 */
export type VaultScope = "app" | "project";

export interface VaultListing {
  key: string;
  secret: boolean;
  /** Null for a secret. */
  value: string | null;
  scope: VaultScope;
}

export interface EnvVaultClient {
  available: () => boolean;
  list: (scope: VaultScope, projectPath: string | null) => Promise<VaultListing[]>;
  set: (
    scope: VaultScope,
    projectPath: string | null,
    key: string,
    value: string,
    secret: boolean,
  ) => Promise<void>;
  delete: (scope: VaultScope, projectPath: string | null, key: string) => Promise<void>;
  /** Import `.env` text; resolves to how many names were stored. */
  importDotenv: (
    scope: VaultScope,
    projectPath: string | null,
    text: string,
    secret: boolean,
  ) => Promise<number>;
}

export function createEnvVaultClient(
  invokeCommand: <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
  available: () => boolean,
): EnvVaultClient {
  return {
    available,
    list: (scope, projectPath) =>
      invokeCommand<VaultListing[]>("env_vault_list", { scope, projectPath }),
    set: (scope, projectPath, key, value, secret) =>
      invokeCommand<void>("env_vault_set", { scope, projectPath, key, value, secret }),
    delete: (scope, projectPath, key) =>
      invokeCommand<void>("env_vault_delete", { scope, projectPath, key }),
    importDotenv: (scope, projectPath, text, secret) =>
      invokeCommand<number>("env_vault_import", { scope, projectPath, text, secret }),
  };
}

function unavailable<T>(): Promise<T> {
  return Promise.reject(new Error("The environment vault is unavailable in the browser preview."));
}

export const envVaultClient: EnvVaultClient = isTauri()
  ? createEnvVaultClient(invoke, isTauri)
  : {
      available: () => false,
      list: async () => [],
      set: unavailable,
      delete: unavailable,
      importDotenv: unavailable,
    };

/** The shell-portable name rule the native side enforces, checked early so the form can say so. */
export function isValidVariableName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && name !== "TALKAK_ENV_KEYS";
}
