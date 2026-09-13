// Builds the session broker and places it where Tauri's externalBin handling expects a sidecar:
// src-tauri/binaries/talkak-dev-broker-<target-triple>[.exe]. Release remains the default for
// packaged builds; `--profile debug` prepares both `tauri dev` and the app-side broker tests from
// a clean checkout.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = join(repo, "session-broker", "Cargo.toml");
const arguments_ = process.argv.slice(2);
let profile = "release";
let requestedTarget =
  process.env.TAURI_ENV_TARGET_TRIPLE?.trim() || process.env.CARGO_BUILD_TARGET?.trim() || "";

for (let index = 0; index < arguments_.length; index += 1) {
  const argument = arguments_[index];
  if (argument === "--profile" || argument === "--target") {
    const value = arguments_[index + 1]?.trim();
    if (!value) throw new Error(`${argument} requires a value`);
    if (argument === "--profile") profile = value;
    else requestedTarget = value;
    index += 1;
    continue;
  }
  if (argument.startsWith("--profile=")) {
    profile = argument.slice("--profile=".length).trim();
    continue;
  }
  if (argument.startsWith("--target=")) {
    requestedTarget = argument.slice("--target=".length).trim();
    continue;
  }
  throw new Error(`unknown argument: ${argument}`);
}

if (profile !== "debug" && profile !== "release") {
  throw new Error(`profile must be debug or release, received: ${profile}`);
}

const rustcInfo = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
const hostTriple = rustcInfo.match(/^host: (.+)$/m)?.[1];
if (!hostTriple) throw new Error(`could not read host triple from rustc -vV:\n${rustcInfo}`);

const targetTriple = requestedTarget || hostTriple;
const crossTarget = targetTriple !== hostTriple;
const cargoArguments = ["build", "--manifest-path", manifest, "--locked"];
if (profile === "release") cargoArguments.push("--release");
if (crossTarget) cargoArguments.push("--target", targetTriple);

execFileSync("cargo", cargoArguments, { stdio: "inherit" });

const suffix = targetTriple.includes("windows") ? ".exe" : "";
const targetDirectory = crossTarget
  ? join(repo, "session-broker", "target", targetTriple, profile)
  : join(repo, "session-broker", "target", profile);
const built = join(targetDirectory, `talkak-dev-broker${suffix}`);
const outDir = join(repo, "src-tauri", "binaries");
mkdirSync(outDir, { recursive: true });
const placed = join(outDir, `talkak-dev-broker-${targetTriple}${suffix}`);
copyFileSync(built, placed);
console.log(`BROKER_SIDECAR_OK: profile=${profile} target=${targetTriple} path=${placed}`);
