import assert from "node:assert/strict";
import test from "node:test";
import { validateDesktopCi } from "./desktopCiContract.mjs";

const smokeScript = [
  '"*-setup.exe"',
  '"talkak-dev.exe"',
  '"uninstall.exe"',
  '"/S"',
  "TALKAK_WINDOWS_APP",
  '"main/talkak-windows-ci"',
  "pnpm e2e:windows",
  "WINDOWS_PRODUCT_E2E_OK",
].join("\n");

const webdriverConfig = ['driverProvider: "embedded"', "appBinaryPath: installedAppPath"].join(
  "\n",
);

const webdriverBoundary = [
  'webdriver-ci = ["dep:tauri-plugin-wdio", "dep:tauri-plugin-wdio-webdriver"]',
  'tauri-plugin-wdio = { version = "=1.3.0", optional = true }',
  'tauri-plugin-wdio-webdriver = { version = "=1.3.0", optional = true }',
  '#[cfg(feature = "webdriver-ci")]',
  "tauri_plugin_wdio::init()",
  "tauri_plugin_wdio_webdriver::init()",
  "__TALKAK_WEBDRIVER_CI__",
  'import("@wdio/tauri-plugin")',
  'mode === "webdriver-ci"',
  "node scripts/check-webdriver-bundle.mjs absent",
  "node scripts/check-webdriver-bundle.mjs present",
  'const markers = ["__wdio_original_core__", "WDIO Tauri Plugin"]',
].join("\n");

const windowsCiConfig = JSON.stringify({
  build: { beforeBuildCommand: "pnpm build:webdriver-ci" },
  app: {
    withGlobalTauri: true,
    security: {
      capabilities: [
        {
          identifier: "windows-ci",
          permissions: ["wdio:default", "wdio-webdriver:default"],
        },
      ],
    },
  },
});

const baseWorkflow = `
on:
  push:
  pull_request:
  workflow_dispatch:
jobs:
  macos-product:
    name: macOS / product gate
    runs-on: \${{ github.event_name == 'pull_request' && 'macos-latest' || vars.CI_MACOS_RUNNER || 'macos-latest' }}
    steps:
      - run: pnpm ci:contract
      - run: pnpm test
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm build
      - run: cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
      - run: cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
      - run: cargo test --manifest-path src-tauri/Cargo.toml --lib --locked
      - run: pnpm tauri build --bundles app --no-sign --ci
      - run: test -x "src-tauri/target/release/bundle/macos/Talkak Dev.app/Contents/MacOS/talkak-dev"
  windows-product:
    name: Windows / product gate
    runs-on: \${{ github.event_name == 'pull_request' && 'windows-latest' || vars.CI_WINDOWS_RUNNER || 'windows-latest' }}
    steps:
      - run: pnpm ci:contract
      - run: pnpm test
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm build
      - run: cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
      - run: cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
      - run: cargo test --manifest-path src-tauri/Cargo.toml --lib --locked
      - run: pnpm tauri build --features webdriver-ci --bundles nsis --no-sign --ci --config src-tauri/tauri.windows-ci.conf.json
      - run: ./scripts/verify-windows-package.ps1
`;

function validate(
  workflow = baseWorkflow,
  config = webdriverConfig,
  boundary = webdriverBoundary,
  tauriConfig = windowsCiConfig,
) {
  return validateDesktopCi(workflow, smokeScript, config, boundary, tauriConfig);
}

test("accepts the complete desktop gate", () => {
  assert.deepEqual(validate(), []);
});

test("rejects conditionally disabled jobs", () => {
  const mutated = baseWorkflow.replace(
    "  windows-product:\n",
    "  windows-product:\n    if: false\n",
  );
  assert.match(validate(mutated).join("\n"), /conditionally disabled/u);
});

test("rejects branch-filtered triggers", () => {
  const mutated = baseWorkflow.replace("  push:\n", "  push:\n    branches: [main]\n");
  assert.match(validate(mutated).join("\n"), /must not restrict branches/u);
});

test("rejects inline trigger restrictions", () => {
  const mutated = baseWorkflow.replace("  push:\n", "  push: { branches: [main] }\n");
  assert.match(validate(mutated).join("\n"), /must not restrict branches/u);
});

test("rejects pull request type filters", () => {
  const mutated = baseWorkflow.replace(
    "  pull_request:\n",
    "  pull_request:\n    types: [opened]\n",
  );
  assert.match(validate(mutated).join("\n"), /every event/u);
});

test("rejects cancelled previous runs", () => {
  const mutated = baseWorkflow.replace(
    "jobs:\n",
    "concurrency:\n  cancel-in-progress: true\njobs:\n",
  );
  assert.match(validate(mutated).join("\n"), /must not cancel/u);
});

test("rejects non-blocking jobs", () => {
  const mutated = baseWorkflow.replace(
    "  macos-product:\n",
    "  macos-product:\n    continue-on-error: true\n",
  );
  assert.match(validate(mutated).join("\n"), /merge-blocking/u);
});

test("rejects skipped required steps", () => {
  const mutated = baseWorkflow.replace(
    "      - run: pnpm test\n",
    "      - if: false\n        run: pnpm test\n",
  );
  assert.match(validate(mutated).join("\n"), /conditionally skips/u);
});

test("rejects allowed failures on required steps", () => {
  const mutated = baseWorkflow.replace(
    "      - run: pnpm typecheck\n",
    "      - continue-on-error: true\n        run: pnpm typecheck\n",
  );
  assert.match(validate(mutated).join("\n"), /allows failure/u);
});

test("rejects jobs gated by dependencies", () => {
  const mutated = baseWorkflow.replace(
    "  windows-product:\n",
    "  windows-product:\n    needs: setup\n",
  );
  assert.match(validate(mutated).join("\n"), /skippable job/u);
});

test("rejects an external Windows driver", () => {
  const mutated = webdriverConfig.replace(
    'driverProvider: "embedded"',
    'driverProvider: "external"',
  );
  assert.match(validate(baseWorkflow, mutated).join("\n"), /Windows WebDriver config is missing/u);
});

test("rejects an unguarded embedded WebDriver", () => {
  const mutated = webdriverBoundary.replace('#[cfg(feature = "webdriver-ci")]', "");
  assert.match(validate(baseWorkflow, webdriverConfig, mutated).join("\n"), /boundary is missing/u);
});

test("rejects embedded WebDriver in default product features", () => {
  const mutated = `${webdriverBoundary}\ndefault = ["webdriver-ci"]`;
  assert.match(validate(baseWorkflow, webdriverConfig, mutated).join("\n"), /must not be enabled/u);
});

test("rejects a WebDriver capability outside app.security", () => {
  const mutated = JSON.stringify({
    build: { beforeBuildCommand: "pnpm build:webdriver-ci" },
    app: {
      withGlobalTauri: true,
      capabilities: [
        {
          identifier: "windows-ci",
          permissions: ["wdio:default", "wdio-webdriver:default"],
        },
      ],
    },
  });
  assert.match(
    validate(baseWorkflow, webdriverConfig, webdriverBoundary, mutated).join("\n"),
    /app\.security\.capabilities/u,
  );
});

test("rejects a Windows CI build without its frontend adapter mode", () => {
  const mutated = windowsCiConfig.replace("pnpm build:webdriver-ci", "pnpm build");
  assert.match(
    validate(baseWorkflow, webdriverConfig, webdriverBoundary, mutated).join("\n"),
    /WebDriver frontend mode/u,
  );
});

test("rejects a Windows CI capability without the service permission", () => {
  const mutated = windowsCiConfig.replace('"wdio:default",', "");
  assert.match(
    validate(baseWorkflow, webdriverConfig, webdriverBoundary, mutated).join("\n"),
    /missing wdio:default/u,
  );
});
