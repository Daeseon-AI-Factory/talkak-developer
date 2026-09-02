import { resolve } from "node:path";

const appBinary = process.env.TALKAK_MACOS_APP;

if (process.platform !== "darwin") {
  throw new Error("The macOS product E2E suite must run on a native macOS host.");
}
if (!appBinary) {
  throw new Error("TALKAK_MACOS_APP must point to the executable inside the built Talkak .app.");
}

const appBinaryPath = resolve(appBinary);

export const config = {
  runner: "local",
  specs: ["./e2e/macos-product.e2e.mjs", "./e2e/macos-stream.e2e.mjs"],
  maxInstances: 1,
  services: [
    [
      "@wdio/tauri-service",
      {
        appBinaryPath,
        driverProvider: "embedded",
      },
    ],
  ],
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": { application: appBinaryPath },
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
