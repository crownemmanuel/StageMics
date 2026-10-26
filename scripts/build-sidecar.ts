// Builds the service (app/server) into one executable the desktop app runs next to itself:
// esbuild bundles it into one CommonJS file, then Node turns that into a single-executable application
// (node --build-sea), named the way Tauri expects a sidecar: src-tauri/binaries/mics-server-<target triple>[.exe].
//
//   node scripts/build-sidecar.ts            for this computer
//   node scripts/build-sidecar.ts --target aarch64-apple-darwin
//
// The executable carries Node itself (about 100 MB, compressed in the installer), so the show computer needs
// nothing installed. It must be built on the platform it is for (CI builds each one on its own runner).

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "build");
const argTarget = process.argv.indexOf("--target");
const triple =
  argTarget > 0
    ? process.argv[argTarget + 1]
    : execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }).trim();
const exe = join(root, "src-tauri", "binaries", `mics-server-${triple}${triple.includes("windows") ? ".exe" : ""}`);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
mkdirSync(dirname(exe), { recursive: true });

await build({
  entryPoints: [join(root, "app", "server", "main.ts")],
  outfile: join(out, "server.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  // ws asks for these speed-ups if they are installed; it works without them.
  external: ["bufferutil", "utf-8-validate"],
  // CommonJS has no import.meta: point it at the executable (paths are given by the app anyway).
  define: { "import.meta.url": "__importMetaUrl", "import.meta.dirname": "__dirname" },
  banner: { js: 'const __importMetaUrl = require("node:url").pathToFileURL(__filename).href;' },
  legalComments: "none",
  logLevel: "warning",
});

const config = join(out, "sea-config.json");
writeFileSync(config, JSON.stringify({ main: join(out, "server.cjs"), output: exe, disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false }));
execFileSync(await seaCapableNode(), ["--build-sea", config], { stdio: "inherit" });
if (process.platform === "darwin") {
  // The injected blob breaks the binary's signature; an ad-hoc one lets macOS run it (the app is signed as a whole later).
  execFileSync("codesign", ["--sign", "-", "--force", exe], { stdio: "inherit" });
}
if (process.platform !== "win32") chmodSync(exe, 0o755);
console.log(`sidecar: ${exe}`);

/**
 * A Node that can become a single executable. Official builds (nodejs.org, actions/setup-node) can; some
 * package-manager builds (Homebrew) cannot. Then the official build of the same version is downloaded once
 * into .cache/, checked against nodejs.org's SHA-256 list, and used instead.
 */
async function seaCapableNode(): Promise<string> {
  const { readFileSync, existsSync } = await import("node:fs");
  if (readFileSync(process.execPath).includes("NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2")) return process.execPath;
  const v = process.version;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const plat = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win" : "linux";
  const name = `node-${v}-${plat}-${arch}`;
  const dir = join(root, ".cache");
  const bin = process.platform === "win32" ? join(dir, name, "node.exe") : join(dir, name, "bin", "node");
  if (existsSync(bin)) return bin;
  mkdirSync(dir, { recursive: true });
  const file = plat === "win" ? `${name}.zip` : `${name}.tar.gz`;
  console.log(`sidecar: this Node (${process.execPath}) cannot build a single executable; fetching the official ${name}`);
  const base = `https://nodejs.org/dist/${v}`;
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const want = sums.split("\n").find((l) => l.endsWith(`  ${file}`))?.split(/\s+/)[0];
  if (!want) throw new Error(`No checksum for ${file} on nodejs.org`);
  const buf = Buffer.from(await (await fetch(`${base}/${file}`)).arrayBuffer());
  const { createHash } = await import("node:crypto");
  const got = createHash("sha256").update(buf).digest("hex");
  if (got !== want) throw new Error(`${file}: checksum mismatch (${got} ≠ ${want})`);
  const archive = join(dir, file);
  writeFileSync(archive, buf);
  execFileSync("tar", ["-xf", archive, "-C", dir], { stdio: "inherit" });
  rmSync(archive);
  return bin;
}
