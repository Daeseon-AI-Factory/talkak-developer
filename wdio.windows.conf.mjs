import { resolve } from "node:path";

const installedApp = process.env.TALKAK_WINDOWS_APP;
const e2eProfile = process.env.TALKAK_WINDOWS_E2E_PROFILE;

if (process.platform !== "win32") {
  throw new Error("The installed-app E2E suite must run on a native Windows host.");
}
if (!installedApp) {
  throw new Error("TALKAK_WINDOWS_APP must point to the installed Talkak executable.");
}
if (!e2eProfile) {
  throw new Error(
    "TALKAK_WINDOWS_E2E_PROFILE must point to the isolated WebView2 user data folder.",
  );
}

const installedAppPath = resolve(installedApp);
const e2eProfilePath = resolve(e2eProfile);

export const config = {
  runner: "local",
  specs: ["./e2e/windows-product.e2e.mjs"],
  maxInstances: 1,
  services: [
    [
      "@wdio/tauri-service",
      {
        appBinaryPath: installedAppPath,
        driverProvider: "external",
        autoInstallTauriDriver: false,
        autoDownloadEdgeDriver: true,
      },
    ],
  ],
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": {
        application: installedAppPath,
        // EdgeDriver must watch the same WebView2 profile that Tauri opens.
        webviewOptions: { userDataFolder: e2eProfilePath },
      },
    },
  ],
  logLevel: "info",
  reporters: ["spec"],
  framework: "mocha",
  waitforTimeout: 20_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 2,
  mochaOpts: { ui: "bdd", timeout: 120_000 },
};
