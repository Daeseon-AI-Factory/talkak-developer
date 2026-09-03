import { isTauri } from "@tauri-apps/api/core";

/**
 * Self-update, with every state a person can be told the truth about.
 *
 * The desktop shell checks its release feed once at launch and again on request. Nothing here can
 * block launch: a failed check is a fact shown in Settings, never a modal, and never an exception
 * that stops the workspace from opening. The browser preview has no updater; that is a state too.
 *
 * Installing is a deliberate click. The download is signed by the release key and verified by
 * the native plugin before anything is replaced; the app relaunches itself when the install lands.
 */
export type AppUpdateState =
  | { kind: "unsupported" }
  | { kind: "idle"; currentVersion: string | null }
  | { kind: "checking"; currentVersion: string | null }
  | { kind: "current"; currentVersion: string; checkedAt: string }
  | { kind: "available"; currentVersion: string; version: string; notes: string | null }
  | {
      kind: "installing";
      currentVersion: string;
      version: string;
      downloadedBytes: number;
      totalBytes: number | null;
    }
  | { kind: "installed"; version: string }
  | { kind: "failed"; currentVersion: string | null; message: string };

/** What the native updater hands back for one release check. */
export interface AvailableUpdate {
  currentVersion: string;
  version: string;
  body: string | null;
  downloadAndInstall: (onProgress: (event: UpdateDownloadEvent) => void) => Promise<void>;
}

export type UpdateDownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

/** The two native calls, behind an interface a test can hand in. */
export interface AppUpdateClient {
  available: () => boolean;
  /** The installed version, or null when the shell cannot say. */
  currentVersion: () => Promise<string | null>;
  /** Null when the feed's newest release is the one running. */
  check: () => Promise<AvailableUpdate | null>;
  relaunch: () => Promise<void>;
}

export function createAppUpdateClient(): AppUpdateClient {
  return {
    available: () => isTauri(),
    currentVersion: async () => {
      const { getVersion } = await import("@tauri-apps/api/app");
      return getVersion().catch(() => null);
    },
    check: async () => {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (!update) return null;
      return {
        currentVersion: update.currentVersion,
        version: update.version,
        body: update.body ?? null,
        downloadAndInstall: (onProgress) => update.downloadAndInstall(onProgress),
      };
    },
    relaunch: async () => {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    },
  };
}

export const appUpdateClient = createAppUpdateClient();

export interface AppUpdater {
  /** Ask the feed. Resolves to the resulting state; never throws. */
  check: () => Promise<AppUpdateState>;
  /** Download, verify, install and relaunch the available release. Never throws. */
  install: () => Promise<AppUpdateState>;
  subscribe: (listener: (state: AppUpdateState) => void) => () => void;
  state: () => AppUpdateState;
}

export function createAppUpdater(client: AppUpdateClient): AppUpdater {
  let state: AppUpdateState = client.available()
    ? { kind: "idle", currentVersion: null }
    : { kind: "unsupported" };
  let pending: AvailableUpdate | null = null;
  let inFlight: Promise<AppUpdateState> | null = null;
  const listeners = new Set<(state: AppUpdateState) => void>();

  const set = (next: AppUpdateState): AppUpdateState => {
    state = next;
    for (const listener of listeners) listener(next);
    return next;
  };

  const currentVersion = () =>
    "currentVersion" in state && state.currentVersion ? state.currentVersion : null;

  const check = async (): Promise<AppUpdateState> => {
    if (!client.available()) return set({ kind: "unsupported" });
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const installed = (await client.currentVersion()) ?? currentVersion();
      set({ kind: "checking", currentVersion: installed });
      try {
        const update = await client.check();
        if (!update) {
          pending = null;
          return set({
            kind: "current",
            currentVersion: installed ?? "?",
            checkedAt: new Date().toISOString(),
          });
        }
        pending = update;
        return set({
          kind: "available",
          currentVersion: update.currentVersion || installed || "?",
          version: update.version,
          notes: update.body,
        });
      } catch (cause: unknown) {
        return set({ kind: "failed", currentVersion: installed, message: describe(cause) });
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  const install = async (): Promise<AppUpdateState> => {
    const update = pending;
    if (!update || state.kind !== "available") return state;
    const installed = update.currentVersion;
    let downloaded = 0;
    let total: number | null = null;
    set({
      kind: "installing",
      currentVersion: installed,
      version: update.version,
      downloadedBytes: 0,
      totalBytes: null,
    });
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? null;
        if (event.event === "Progress") downloaded += event.data.chunkLength;
        set({
          kind: "installing",
          currentVersion: installed,
          version: update.version,
          downloadedBytes: downloaded,
          totalBytes: total,
        });
      });
      pending = null;
      const done = set({ kind: "installed", version: update.version });
      // The relaunch ends this process; a failure to relaunch leaves an honest "installed" state
      // with the person free to restart by hand.
      await client.relaunch().catch(() => undefined);
      return done;
    } catch (cause: unknown) {
      return set({ kind: "failed", currentVersion: installed, message: describe(cause) });
    }
  };

  return {
    check,
    install,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    state: () => state,
  };
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export const appUpdater = createAppUpdater(appUpdateClient);
