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
const errors = validateDesktopCi(workflow, smokeScript, webdriverConfig);

if (errors.length > 0) {
  throw new Error(`Desktop CI contract is incomplete:\n- ${errors.join("\n- ")}`);
}

console.log(
  "DESKTOP_CI_CONTRACT_OK: macOS and Windows source, native PTY, packaging, and Windows installed-product E2E gates are declared.",
);
