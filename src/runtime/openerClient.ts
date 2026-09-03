import { isTauri } from "@tauri-apps/api/core";

/**
 * Handing things to the OS: a URL to the default browser, a folder to Finder or Explorer.
 *
 * Both go through the opener plugin, which the capability file scopes to `opener:default` — it
 * opens http/https/mailto/tel URLs and reveals paths; it does not run arbitrary programs. This
 * client narrows that further: only web URLs leave through `openExternalUrl`, so a link found in
 * agent output can never turn into a `file:` or custom-scheme launch.
 */
export interface OpenerClient {
  available: () => boolean;
  /** Open an http(s) URL in the system browser. Resolves false, and opens nothing, otherwise. */
  openExternalUrl: (url: string) => Promise<boolean>;
  /** Show `path` selected in Finder (macOS) or Explorer (Windows). */
  revealPath: (path: string) => Promise<void>;
}

interface OpenerPlugin {
  openUrl: (url: string) => Promise<void>;
  revealItemInDir: (path: string) => Promise<void>;
}

const WEB_SCHEMES = new Set(["http:", "https:"]);

/** Whether `candidate` is a URL this app will hand to the browser: absolute, http or https. */
export function isExternalWebUrl(candidate: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(candidate.trim());
  } catch {
    return false;
  }
  return WEB_SCHEMES.has(parsed.protocol) && parsed.hostname.length > 0;
}

export function createOpenerClient(
  available: () => boolean,
  loadPlugin: () => Promise<OpenerPlugin>,
): OpenerClient {
  return {
    available,
    async openExternalUrl(url) {
      if (!available() || !isExternalWebUrl(url)) return false;
      const plugin = await loadPlugin();
      await plugin.openUrl(url.trim());
      return true;
    },
    async revealPath(path) {
      if (!available()) throw new Error("Revealing a folder needs the desktop app.");
      const plugin = await loadPlugin();
      await plugin.revealItemInDir(path);
    },
  };
}

export const openerClient: OpenerClient = createOpenerClient(isTauri, async () => {
  const { openUrl, revealItemInDir } = await import("@tauri-apps/plugin-opener");
  return { openUrl, revealItemInDir };
});
