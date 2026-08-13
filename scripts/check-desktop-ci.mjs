import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateDesktopCi } from "./desktopCiContract.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const workflow = readFileSync(resolve(repositoryRoot, ".github/workflows/desktop.yml"), "utf8");
const smokeScript = readFileSync(
  resolve(repositoryRoot, "scripts/verify-windows-package.ps1"),
  "utf8",
);
const webdriverConfig = readFileSync(resolve(repositoryRoot, "wdio.windows.conf.mjs"), "utf8");
const webdriverBoundary = [
  readFileSync(resolve(repositoryRoot, "src-tauri/Cargo.toml"), "utf8"),
  readFileSync(resolve(repositoryRoot, "src-tauri/src/lib.rs"), "utf8"),
].join("\n");
const windowsCiConfig = readFileSync(
  resolve(repositoryRoot, "src-tauri/tauri.windows-ci.conf.json"),
  "utf8",
);
const errors = validateDesktopCi(
  workflow,
  smokeScript,
  webdriverConfig,
  webdriverBoundary,
  windowsCiConfig,
);

if (errors.length > 0) {
  throw new Error(`Desktop CI contract is incomplete:\n- ${errors.join("\n- ")}`);
}

console.log(
  "DESKTOP_CI_CONTRACT_OK: macOS and Windows source, native PTY, packaging, and Windows installed-product E2E gates are declared.",
);
