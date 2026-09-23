import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const expected = process.argv[2];
if (expected !== "absent" && expected !== "present") {
  throw new Error("Expected one bundle boundary argument: absent or present.");
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetsDirectory = resolve(repositoryRoot, "dist/assets");
const javascript = readdirSync(assetsDirectory)
  .filter((name) => name.endsWith(".js"))
  .map((name) => readFileSync(resolve(assetsDirectory, name), "utf8"))
  .join("\n");
const markers = ["__wdio_original_core__", "WDIO Tauri Plugin", "__talkakTest"];
const included = markers.every((marker) => javascript.includes(marker));

if ((expected === "present") !== included) {
  throw new Error(`WebDriver frontend bundle must be ${expected}, but its markers disagree.`);
}

console.log(`WEBDRIVER_BUNDLE_BOUNDARY_OK: test frontend is ${expected}`);
