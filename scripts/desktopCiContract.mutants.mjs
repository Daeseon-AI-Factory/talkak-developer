import assert from "node:assert/strict";
import test from "node:test";
import { validateDesktopCi } from "./desktopCiContract.mjs";

const smokeScript = [
  '"*-setup.exe"',
  '"talkak-dev.exe"',
  '"uninstall.exe"',
  '"/S"',
  "TALKAK_WINDOWS_APP",
  "TALKAK_WINDOWS_PROJECT",
  "RUNNER_TEMP",
  "$runnerTempRoot = [System.IO.Path]::GetFullPath($env:RUNNER_TEMP)",
  "$projectDirectory = [System.IO.Path]::GetFullPath((Join-Path $runnerTempRoot",
  "$projectDirectory.StartsWith($runnerTempRoot",
  "$env:TALKAK_WINDOWS_PROJECT = $projectDirectory",
  '"main/talkak-windows-ci"',
  '"dev.talkak.desktop"',
  "pnpm e2e:windows",
  "WINDOWS_RELEASE_INSTALL_LAUNCH_OK",
  "WINDOWS_PRODUCT_E2E_OK",
].join("\n");

const webdriverConfig = ['driverProvider: "embedded"', "appBinaryPath: installedAppPath"].join(
  "\n",
);
const macosWebdriverConfig = [
  'driverProvider: "embedded"',
  "appBinaryPath,",
  "application: appBinaryPath",
  'specs: ["./e2e/macos-product.e2e.mjs"]',
].join("\n");
const windowsE2e = [
  'import { isAbsolute } from "node:path";',
  "process.env.TALKAK_WINDOWS_PROJECT",
  "!projectPath || !isAbsolute(projectPath)",
  "setValue(projectPath)",
  'execFileSync("whoami.exe"',
  'typeTerminalCommand("whoami")',
  "if (!/^[a-z]+$/u.test(command))",
  ".xterm-helper-textarea",
  "await input.click();",
  "input.addValue(command)",
  "browser.keys(Key.Enter)",
  '[data-testid="runtime-attention-card"]',
  '[data-testid="terminal-log-view"]',
  '[data-testid="ack-runtime-notice"]',
  '[data-testid="attention-list"]',
  "attentionList.isFocused()",
  '[data-phase="exited"]',
  ".terminal-log__host .xterm-rows",
].join("\n");
const macosE2e = [
  'import { isAbsolute } from "node:path";',
  'process.platform !== "darwin"',
  "process.env.TALKAK_MACOS_PROJECT",
  "!projectPath || !isAbsolute(projectPath)",
  "setValue(projectPath)",
  ".xterm-helper-textarea",
  "await input.click();",
  'browser.keys([Key.Command, "v"])',
  'terminalText()).includes("printf")',
  'invokeApp("clipboard_read_text")',
  'invokeApp("clipboard_write_text", { text: command })',
  "finally",
  'invokeApp("clipboard_write_text", { text: originalText })',
  "talkakplaincommandvpaste",
  '[data-phase="exited"]',
  "stopRunningSession",
].join("\n");

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
const macosCiConfig = JSON.stringify({
  identifier: "dev.talkak.desktop.macosci",
  build: { beforeBuildCommand: "pnpm build:webdriver-ci" },
  app: {
    withGlobalTauri: true,
    security: {
      capabilities: [
        {
          identifier: "macos-ci",
          permissions: ["wdio:default", "wdio-webdriver:default"],
        },
      ],
    },
  },
});

const baseWorkflow = `
on:
  push:
    branches:
      - main
  pull_request:
    branches:
      - main
  workflow_dispatch:
concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  macos-product:
    name: macOS / product gate
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803
      - uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020
      - uses: dtolnay/rust-toolchain@a5f673d0ba8626c3977bb416a1612774bc82181b
      - run: pnpm ci:contract
      - run: pnpm test
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm build
      - run: pnpm broker:debug
      - run: cargo fmt --manifest-path session-broker/Cargo.toml -- --check
      - run: cargo clippy --manifest-path session-broker/Cargo.toml --all-targets --locked -- -D warnings
      - run: cargo test --manifest-path session-broker/Cargo.toml --all-targets --locked
      - run: cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
      - run: cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
      - run: cargo test --manifest-path src-tauri/Cargo.toml --lib --locked
      - run: pnpm tauri build --bundles app --no-sign --ci
      - run: test -x "src-tauri/target/release/bundle/macos/Talkak Dev.app/Contents/MacOS/talkak-dev"
      - run: pnpm tauri build --features webdriver-ci --bundles app --no-sign --ci --config src-tauri/tauri.macos-ci.conf.json
      - env:
          TALKAK_MACOS_PROJECT: \${{ runner.temp }}/Talkak-macos-project
        run: mkdir -p "$TALKAK_MACOS_PROJECT"
      - env:
          TALKAK_MACOS_APP: \${{ github.workspace }}/src-tauri/target/release/bundle/macos/Talkak Dev.app/Contents/MacOS/talkak-dev
          TALKAK_MACOS_PROJECT: \${{ runner.temp }}/Talkak-macos-project
        run: pnpm e2e:macos
  windows-product:
    name: Windows / product gate
    runs-on: \${{ github.event_name == 'pull_request' && 'windows-latest' || vars.CI_WINDOWS_RUNNER || 'windows-latest' }}
    steps:
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803
      - uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020
      - uses: dtolnay/rust-toolchain@a5f673d0ba8626c3977bb416a1612774bc82181b
      - run: pnpm ci:contract
      - run: pnpm test
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm build
      - run: pnpm broker:debug
      - run: cargo fmt --manifest-path session-broker/Cargo.toml -- --check
      - run: cargo clippy --manifest-path session-broker/Cargo.toml --all-targets --locked -- -D warnings
      - run: cargo test --manifest-path session-broker/Cargo.toml --all-targets --locked
      - run: cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
      - run: cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
      - run: cargo test --manifest-path src-tauri/Cargo.toml --lib --locked
      - run: pnpm tauri build --bundles nsis --no-sign --ci
      - run: ./scripts/verify-windows-package.ps1 -ReleaseSmoke
      - run: pnpm tauri build --features webdriver-ci --bundles nsis --no-sign --ci --config src-tauri/tauri.windows-ci.conf.json
      - run: ./scripts/verify-windows-package.ps1
`;

function validate(
  workflow = baseWorkflow,
  config = webdriverConfig,
  boundary = webdriverBoundary,
  tauriConfig = windowsCiConfig,
  smoke = smokeScript,
  e2e = windowsE2e,
  macConfig = macosWebdriverConfig,
  macTauriConfig = macosCiConfig,
  macE2e = macosE2e,
) {
  return validateDesktopCi(
    workflow,
    smoke,
    config,
    boundary,
    tauriConfig,
    e2e,
    macConfig,
    macTauriConfig,
    macE2e,
  );
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

test("rejects pushes to every branch", () => {
  const mutated = baseWorkflow.replace("  push:\n    branches:\n      - main\n", "  push:\n");
  assert.match(validate(mutated).join("\n"), /must target main/u);
});

test("rejects a non-main push target", () => {
  const mutated = baseWorkflow.replace("      - main\n", "      - release\n");
  assert.match(validate(mutated).join("\n"), /must target main only/u);
});

test("rejects pull request type filters", () => {
  const mutated = baseWorkflow.replace(
    "  pull_request:\n    branches:\n      - main\n",
    "  pull_request:\n    branches:\n      - main\n    types: [opened]\n",
  );
  assert.match(validate(mutated).join("\n"), /every default activity type/u);
});

test("rejects keeping stale runs", () => {
  const mutated = baseWorkflow.replace(
    "  cancel-in-progress: true\n",
    "  cancel-in-progress: false\n",
  );
  assert.match(validate(mutated).join("\n"), /must cancel stale runs/u);
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

test("rejects a missing clean-checkout broker build", () => {
  const mutated = baseWorkflow.replace("      - run: pnpm broker:debug\n", "");
  assert.match(validate(mutated).join("\n"), /missing command/u);
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

test("rejects a mutable action tag", () => {
  const mutated = baseWorkflow.replace(
    "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",
    "actions/checkout@v6",
  );
  assert.match(validate(mutated).join("\n"), /pinned action|mutable action/u);
});

test("rejects pinned setup actions in the wrong order", () => {
  const pnpmSetup = "      - uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86\n";
  const nodeSetup = "      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020\n";
  const mutated = baseWorkflow
    .replace(pnpmSetup, "__PNPM_SETUP__\n")
    .replace(nodeSetup, pnpmSetup)
    .replace("__PNPM_SETUP__\n", nodeSetup);
  assert.match(validate(mutated).join("\n"), /pinned actions out of contract order/u);
});

test("rejects a mutable Docker action tag", () => {
  const checkout = "      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803\n";
  const mutated = baseWorkflow.replace(
    checkout,
    `${checkout}      - uses: docker://alpine:latest\n`,
  );
  assert.match(validate(mutated).join("\n"), /mutable Docker action reference/u);
});

test("accepts a Docker action pinned by digest", () => {
  const checkout = "      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803\n";
  const digest = "a".repeat(64);
  const workflow = baseWorkflow.replace(
    checkout,
    `${checkout}      - uses: docker://alpine@sha256:${digest}\n`,
  );
  assert.deepEqual(validate(workflow), []);
});

test("rejects assigning the Windows E2E project to the repository", () => {
  const mutated = smokeScript.replace(
    "$env:TALKAK_WINDOWS_PROJECT = $projectDirectory",
    "$env:TALKAK_WINDOWS_PROJECT = $repositoryRoot",
  );
  assert.match(
    validate(baseWorkflow, webdriverConfig, webdriverBoundary, windowsCiConfig, mutated).join("\n"),
    /Windows package script is missing/u,
  );
});

test("rejects removing the absolute external-project guard", () => {
  const mutated = windowsE2e.replace("!projectPath || !isAbsolute(projectPath)", "!projectPath");
  assert.match(
    validate(
      baseWorkflow,
      webdriverConfig,
      webdriverBoundary,
      windowsCiConfig,
      smokeScript,
      mutated,
    ).join("\n"),
    /Windows product E2E is missing/u,
  );
});

test("rejects an installed-product test that does not inspect terminal log rows", () => {
  const mutated = windowsE2e.replace(".terminal-log__host .xterm-rows", ".terminal-log__host");
  assert.match(
    validate(
      baseWorkflow,
      webdriverConfig,
      webdriverBoundary,
      windowsCiConfig,
      smokeScript,
      mutated,
    ).join("\n"),
    /Windows product E2E is missing/u,
  );
});

test("rejects bypassing xterm input for terminal commands", () => {
  const mutated = windowsE2e.replace("input.addValue(command)", "browser.execute(() => command)");
  assert.match(
    validate(
      baseWorkflow,
      webdriverConfig,
      webdriverBoundary,
      windowsCiConfig,
      smokeScript,
      mutated,
    ).join("\n"),
    /Windows product E2E is missing/u,
  );
});

test("rejects focusing the non-input terminal screen", () => {
  const mutated = windowsE2e.replace("await input.click();", "await terminalScreen.click();");
  assert.match(
    validate(
      baseWorkflow,
      webdriverConfig,
      webdriverBoundary,
      windowsCiConfig,
      smokeScript,
      mutated,
    ).join("\n"),
    /Windows product E2E is missing/u,
  );
});

test("rejects terminal probes that allow unsupported uppercase input", () => {
  const mutated = windowsE2e.replace("/^[a-z]+$/u", "/^[A-Z]+$/u");
  assert.match(
    validate(
      baseWorkflow,
      webdriverConfig,
      webdriverBoundary,
      windowsCiConfig,
      smokeScript,
      mutated,
    ).join("\n"),
    /Windows product E2E is missing/u,
  );
});

test("rejects an installed-product review flow that does not restore Attention focus", () => {
  const mutated = windowsE2e.replace("attentionList.isFocused()", "attentionList.isExisting()");
  assert.match(
    validate(
      baseWorkflow,
      webdriverConfig,
      webdriverBoundary,
      windowsCiConfig,
      smokeScript,
      mutated,
    ).join("\n"),
    /Windows product E2E is missing/u,
  );
});

test("rejects a missing ordinary Windows release installer", () => {
  const mutated = baseWorkflow.replace(
    "      - run: pnpm tauri build --bundles nsis --no-sign --ci\n",
    "",
  );
  assert.match(validate(mutated).join("\n"), /missing command/u);
});

test("rejects release and instrumented Windows builds in the wrong order", () => {
  const first = "      - run: pnpm tauri build --bundles nsis --no-sign --ci\n";
  const second =
    "      - run: pnpm tauri build --features webdriver-ci --bundles nsis --no-sign --ci --config src-tauri/tauri.windows-ci.conf.json\n";
  const mutated = baseWorkflow
    .replace(first, "__FIRST__\n")
    .replace(second, first)
    .replace("__FIRST__\n", second);
  assert.match(validate(mutated).join("\n"), /out of contract order/u);
});

test("rejects a missing instrumented macOS app build", () => {
  const mutated = baseWorkflow.replace(
    "      - run: pnpm tauri build --features webdriver-ci --bundles app --no-sign --ci --config src-tauri/tauri.macos-ci.conf.json\n",
    "",
  );
  assert.match(validate(mutated).join("\n"), /missing command/u);
});

test("rejects a macOS WebDriver config that does not use the embedded provider", () => {
  const mutated = macosWebdriverConfig.replace(
    'driverProvider: "embedded"',
    'driverProvider: "external"',
  );
  assert.match(
    validate(
      baseWorkflow,
      webdriverConfig,
      webdriverBoundary,
      windowsCiConfig,
      smokeScript,
      windowsE2e,
      mutated,
    ).join("\n"),
    /macOS WebDriver config is missing/u,
  );
});

test("rejects a macOS paste test that sends Control+V instead of Command+V", () => {
  const mutated = macosE2e.replace("Key.Command", "Key.Control");
  assert.match(
    validate(
      baseWorkflow,
      webdriverConfig,
      webdriverBoundary,
      windowsCiConfig,
      smokeScript,
      windowsE2e,
      macosWebdriverConfig,
      macosCiConfig,
      mutated,
    ).join("\n"),
    /macOS product E2E is missing/u,
  );
});

test("rejects a macOS paste test that does not restore the native clipboard", () => {
  const mutated = macosE2e.replace(
    'invokeApp("clipboard_write_text", { text: originalText })',
    "clipboard left changed",
  );
  assert.match(
    validate(
      baseWorkflow,
      webdriverConfig,
      webdriverBoundary,
      windowsCiConfig,
      smokeScript,
      windowsE2e,
      macosWebdriverConfig,
      macosCiConfig,
      mutated,
    ).join("\n"),
    /macOS product E2E is missing/u,
  );
});
