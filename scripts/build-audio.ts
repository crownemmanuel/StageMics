// Builds the audio capture helper (native/audio, Rust) and puts it where Tauri expects a sidecar:
// src-tauri/binaries/stagemics-audio-<target triple>[.exe]. The installer ships it next to mics-server,
// which starts it to read the Dante Virtual Soundcard (see docs/APP.md, "Dante audio and the recorder").
//
//   node scripts/build-audio.ts            for this computer
//   node scripts/build-audio.ts --target aarch64-apple-darwin

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const crate = join(root, "native", "audio");
const argTarget = process.argv.indexOf("--target");
const host = execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }).trim();
const triple = argTarget > 0 ? process.argv[argTarget + 1] : host;
const ext = triple.includes("windows") ? ".exe" : "";

const cargoArgs = ["build", "--release", "--manifest-path", join(crate, "Cargo.toml")];
if (triple !== host) cargoArgs.push("--target", triple);
execFileSync("cargo", cargoArgs, { stdio: "inherit" });

const built = join(crate, "target", ...(triple !== host ? [triple] : []), "release", `stagemics-audio${ext}`);
const exe = join(root, "src-tauri", "binaries", `stagemics-audio-${triple}${ext}`);
mkdirSync(dirname(exe), { recursive: true });
copyFileSync(built, exe);
if (process.platform !== "win32") chmodSync(exe, 0o755);
console.log(`audio helper: ${exe}`);
