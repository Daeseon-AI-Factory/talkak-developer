import assert from "node:assert/strict";
import test from "node:test";
import { validateDesktopCi } from "./desktopCiContract.mjs";

const smokeScript = [
  '"*-setup.exe"',
  '"talkak-dev.exe"',
  '"uninstall.exe"',
  '"/S"',
  "TALKAK_WINDOWS_APP",
  "TALKAK_WINDOWS_E2E_PROFILE",
  "pnpm e2e:windows",
  "WINDOWS_PRODUCT_E2E_OK",
].join("\n");

const webdriverConfig = [
  "TALKAK_WINDOWS_E2E_PROFILE",
  "webviewOptions",
  "userDataFolder: e2eProfilePath",
].join("\n");

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
      - run: cargo install tauri-driver --version 2.0.6 --locked
      - run: pnpm tauri build --bundles nsis --no-sign --ci --config src-tauri/tauri.windows-ci.conf.json
      - run: ./scripts/verify-windows-package.ps1
`;

function validate(workflow = baseWorkflow, config = webdriverConfig) {
  return validateDesktopCi(workflow, smokeScript, config);
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

test("rejects a WebDriver profile that is not forwarded to EdgeDriver", () => {
  const mutated = webdriverConfig.replace("userDataFolder: e2eProfilePath", "");
  assert.match(validate(baseWorkflow, mutated).join("\n"), /Windows WebDriver config is missing/u);
});
