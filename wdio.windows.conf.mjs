import { resolve } from "node:path";

const installedApp = process.env.TALKAK_WINDOWS_APP;

if (process.platform !== "win32") {
  throw new Error("The installed-app E2E suite must run on a native Windows host.");
}
if (!installedApp) {
  throw new Error("TALKAK_WINDOWS_APP must point to the installed Talkak executable.");
}

export const config = {
  runner: "local",
  specs: ["./e2e/windows-product.e2e.mjs"],
  maxInstances: 1,
  services: [
    [
      "@wdio/tauri-service",
      {
        appBinaryPath: resolve(installedApp),
        driverProvider: "external",
        autoInstallTauriDriver: false,
        autoDownloadEdgeDriver: true,
      },
    ],
  ],
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": { application: resolve(installedApp) },
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
