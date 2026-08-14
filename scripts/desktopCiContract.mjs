import { parseDocument } from "yaml";

const REQUIRED_TRIGGERS = ["push", "pull_request", "workflow_dispatch"];
const FORBIDDEN_EVENT_FILTERS = ["branches-ignore", "paths", "paths-ignore", "tags", "tags-ignore"];
const MAIN_BRANCH_ONLY = ["main"];
const CONCURRENCY_GROUP = "${{ github.workflow }}-${{ github.ref }}";
const PINNED_ACTIONS = [
  "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",
  "pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86",
  "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
  "dtolnay/rust-toolchain@a5f673d0ba8626c3977bb416a1612774bc82181b",
];

const JOBS = {
  "macos-product": {
    name: "macOS / product gate",
    runner:
      "${{ github.event_name == 'pull_request' && 'macos-latest' || vars.CI_MACOS_RUNNER || 'macos-latest' }}",
    commands: [
      "pnpm ci:contract",
      "pnpm test",
      "pnpm typecheck",
      "pnpm lint",
      "pnpm build",
      "cargo fmt --manifest-path src-tauri/Cargo.toml -- --check",
      "cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings",
      "cargo test --manifest-path src-tauri/Cargo.toml --lib --locked",
      "pnpm tauri build --bundles app --no-sign --ci",
      'test -x "src-tauri/target/release/bundle/macos/Talkak Dev.app/Contents/MacOS/talkak-dev"',
    ],
  },
  "windows-product": {
    name: "Windows / product gate",
    runner:
      "${{ github.event_name == 'pull_request' && 'windows-latest' || vars.CI_WINDOWS_RUNNER || 'windows-latest' }}",
    commands: [
      "pnpm ci:contract",
      "pnpm test",
      "pnpm typecheck",
      "pnpm lint",
      "pnpm build",
      "cargo fmt --manifest-path src-tauri/Cargo.toml -- --check",
      "cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings",
      "cargo test --manifest-path src-tauri/Cargo.toml --lib --locked",
      "pnpm tauri build --bundles nsis --no-sign --ci",
      "./scripts/verify-windows-package.ps1 -ReleaseSmoke",
      "pnpm tauri build --features webdriver-ci --bundles nsis --no-sign --ci --config src-tauri/tauri.windows-ci.conf.json",
      "./scripts/verify-windows-package.ps1",
    ],
  },
};

export function validateDesktopCi(
  workflowSource,
  smokeScriptSource,
  webdriverConfigSource = "",
  webdriverBoundarySource = "",
  windowsCiConfigSource = "",
  windowsE2eSource = "",
) {
  const document = parseDocument(workflowSource);
  if (document.errors.length > 0) {
    return document.errors.map((error) => `Invalid workflow YAML: ${error.message}`);
  }
  const workflow = document.toJS();
  const errors = [];
  if (!workflow || typeof workflow !== "object") return ["Workflow root must be a mapping."];

  const triggers = workflow.on;
  if (!triggers || typeof triggers !== "object" || Array.isArray(triggers)) {
    errors.push("Workflow triggers must be an explicit mapping.");
  } else {
    const triggerNames = Object.keys(triggers);
    for (const trigger of REQUIRED_TRIGGERS) {
      if (!triggerNames.includes(trigger)) errors.push(`Missing ${trigger} trigger.`);
    }
    for (const trigger of ["push", "pull_request"]) {
      const config = triggers[trigger];
      if (!config || typeof config !== "object" || Array.isArray(config)) {
        errors.push(`${trigger} trigger must target main through an explicit mapping.`);
        continue;
      }
      if (
        !Array.isArray(config.branches) ||
        config.branches.length !== MAIN_BRANCH_ONLY.length ||
        config.branches.some((branch, index) => branch !== MAIN_BRANCH_ONLY[index])
      ) {
        errors.push(`${trigger} trigger must target main only.`);
      }
      for (const filter of FORBIDDEN_EVENT_FILTERS) {
        if (Object.hasOwn(config, filter)) {
          errors.push(`${trigger} trigger must not restrict ${filter}.`);
        }
      }
      if (Object.hasOwn(config, "types")) {
        errors.push(`${trigger} trigger must use every default activity type.`);
      }
    }
  }

  if (workflow.concurrency?.group !== CONCURRENCY_GROUP) {
    errors.push("Desktop product gates must isolate concurrency by workflow and ref.");
  }
  if (workflow.concurrency?.["cancel-in-progress"] !== true) {
    errors.push("Desktop product gates must cancel stale runs for the same ref.");
  }

  const jobs = workflow.jobs;
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) {
    errors.push("Workflow jobs must be a mapping.");
  } else {
    for (const [jobId, contract] of Object.entries(JOBS)) {
      const job = jobs[jobId];
      if (!job || typeof job !== "object" || Array.isArray(job)) {
        errors.push(`Missing ${jobId} job.`);
        continue;
      }
      if (Object.hasOwn(job, "if")) errors.push(`${jobId} must not be conditionally disabled.`);
      if (Object.hasOwn(job, "needs")) errors.push(`${jobId} must not depend on a skippable job.`);
      if (job.name !== contract.name) errors.push(`${jobId} has an unstable check name.`);
      if (job["runs-on"] !== contract.runner) errors.push(`${jobId} has the wrong runner.`);
      if (job["continue-on-error"] === true) errors.push(`${jobId} must remain merge-blocking.`);

      const steps = Array.isArray(job.steps) ? job.steps : [];
      let previousActionIndex = -1;
      for (const action of PINNED_ACTIONS) {
        const actionIndexes = steps.flatMap((candidate, index) =>
          candidate?.uses === action ? [index] : [],
        );
        if (actionIndexes.length !== 1) {
          errors.push(`${jobId} must use pinned action exactly once: ${action}`);
          continue;
        }
        const [actionIndex] = actionIndexes;
        if (actionIndex <= previousActionIndex) {
          errors.push(`${jobId} uses pinned actions out of contract order: ${action}`);
        }
        previousActionIndex = actionIndex;
      }
      for (const step of steps) {
        if (typeof step?.uses !== "string" || step.uses.startsWith("./")) continue;
        if (step.uses.startsWith("docker://")) {
          if (!/^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/u.test(step.uses)) {
            errors.push(`${jobId} uses a mutable Docker action reference: ${step.uses}`);
          }
        } else if (!/@[0-9a-f]{40}$/u.test(step.uses)) {
          errors.push(`${jobId} uses a mutable action reference: ${step.uses}`);
        }
      }
      let previousCommandIndex = -1;
      for (const command of contract.commands) {
        const commandIndex = steps.findIndex(
          (candidate) => normalizeCommand(candidate?.run) === command,
        );
        if (commandIndex < 0) {
          errors.push(`${jobId} is missing command: ${command}`);
          continue;
        }
        if (commandIndex <= previousCommandIndex) {
          errors.push(`${jobId} runs commands out of contract order: ${command}`);
        }
        previousCommandIndex = commandIndex;
        const step = steps[commandIndex];
        if (Object.hasOwn(step, "if")) errors.push(`${jobId} conditionally skips: ${command}`);
        if (step["continue-on-error"] === true) {
          errors.push(`${jobId} allows failure for: ${command}`);
        }
      }
    }
  }

  const smokeFragments = [
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
  ];
  for (const fragment of smokeFragments) {
    if (!smokeScriptSource.includes(fragment)) {
      errors.push(`Windows package script is missing: ${fragment}`);
    }
  }

  const webdriverFragments = ['driverProvider: "embedded"', "appBinaryPath: installedAppPath"];
  for (const fragment of webdriverFragments) {
    if (!webdriverConfigSource.includes(fragment)) {
      errors.push(`Windows WebDriver config is missing: ${fragment}`);
    }
  }

  for (const fragment of [
    'import { isAbsolute } from "node:path";',
    "process.env.TALKAK_WINDOWS_PROJECT",
    "!projectPath || !isAbsolute(projectPath)",
    "setValue(projectPath)",
    "TALKAK_ATTENTION_LOG_OK",
    '[data-testid="runtime-attention-card"]',
    '[data-testid="terminal-log-view"]',
    '[data-testid="ack-runtime-notice"]',
    '[data-testid="attention-list"]',
    "attentionList.isFocused()",
    '[data-phase="exited"]',
    ".terminal-log__host .xterm-rows",
  ]) {
    if (!windowsE2eSource.includes(fragment)) {
      errors.push(`Windows product E2E is missing: ${fragment}`);
    }
  }

  const boundaryFragments = [
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
  ];
  for (const fragment of boundaryFragments) {
    if (!webdriverBoundarySource.includes(fragment)) {
      errors.push(`CI-only WebDriver boundary is missing: ${fragment}`);
    }
  }
  if (/^\s*default\s*=\s*\[[^\]]*webdriver-ci/mu.test(webdriverBoundarySource)) {
    errors.push("webdriver-ci must not be enabled by default in product builds.");
  }

  let windowsCiConfig;
  try {
    windowsCiConfig = JSON.parse(windowsCiConfigSource);
  } catch {
    errors.push("Windows CI Tauri config must be valid JSON.");
  }
  const capabilities = windowsCiConfig?.app?.security?.capabilities;
  if (windowsCiConfig?.build?.beforeBuildCommand !== "pnpm build:webdriver-ci") {
    errors.push("Windows CI Tauri build must compile the WebDriver frontend mode.");
  }
  if (windowsCiConfig?.app?.withGlobalTauri !== true) {
    errors.push("Windows CI Tauri config must expose its API only to the test frontend.");
  }
  if (!Array.isArray(capabilities)) {
    errors.push("Windows CI WebDriver capability must be under app.security.capabilities.");
  } else {
    const webdriverCapability = capabilities.find(
      (capability) => capability?.identifier === "windows-ci",
    );
    const permissions = webdriverCapability?.permissions;
    for (const permission of ["wdio:default", "wdio-webdriver:default"]) {
      if (!Array.isArray(permissions) || !permissions.includes(permission)) {
        errors.push(`Windows CI capability is missing ${permission}.`);
      }
    }
  }
  return errors;
}

function normalizeCommand(command) {
  return typeof command === "string" ? command.replace(/\s+/gu, " ").trim() : "";
}
