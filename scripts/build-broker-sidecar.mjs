// Builds the session broker in release mode and places it where Tauri's externalBin bundling
// expects a sidecar: src-tauri/binaries/talkak-dev-broker-<host-triple>[.exe]. Runs as part of
// beforeBuildCommand so `tauri build` on any machine produces an installer that carries the
// broker beside the app executable.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

execFileSync(
  "cargo",
  ["build", "--release", "--manifest-path", join(repo, "session-broker", "Cargo.toml")],
  {
    stdio: "inherit",
  },
);

const rustcInfo = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
const triple = rustcInfo.match(/^host: (.+)$/m)?.[1];
if (!triple) throw new Error(`could not read host triple from rustc -vV:\n${rustcInfo}`);

const suffix = process.platform === "win32" ? ".exe" : "";
const built = join(repo, "session-broker", "target", "release", `talkak-dev-broker${suffix}`);
const outDir = join(repo, "src-tauri", "binaries");
mkdirSync(outDir, { recursive: true });
const placed = join(outDir, `talkak-dev-broker-${triple}${suffix}`);
copyFileSync(built, placed);
console.log(`BROKER_SIDECAR_OK: ${placed}`);
