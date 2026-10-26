#!/usr/bin/env node
// StageMics service: owns the dLive connection and runs the radio mics scene by scene.
//
//   node app/server/main.ts [--open] [--data <dir>] [--dist <dir>] [--http-port 1450] [--osc-port 1451] [--desk-readonly]
//
// Env equivalents: SOUND_DATA_DIR, SOUND_DIST_DIR (built screens), SOUND_HTTP_PORT, SOUND_OSC_PORT,
// SOUND_DESK_READONLY=1 (only questions ever go to the desk), SOUND_APP_VERSION.
// Once HTTP and OSC are listening it prints one line for an embedding shell:
//   SOUND_READY {"url":"http://localhost:1450","http":1450,"osc":1451,"data":"…","pid":123}
// SIGTERM / SIGINT stop it cleanly (show and live state saved, sockets closed).

import "./args.ts";
import { appendFileSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { SOUND_HTTP_PORT } from "../../shared/soundProtocol.ts";
import { CloudSync } from "./cloud.ts";
import { Engine, UserError } from "./engine.ts";
import { lanAddresses, startHttp, type LogBook } from "./http.ts";
import { fromBridge, importSources, mergeImport, parseLiveStageShow, readShowPath } from "./importer.ts";
import { OscServer } from "./osc.ts";
import { DATA_DIR, loadSettings, loadShow } from "./store.ts";
import { openAppWindow } from "./window.ts";

const HTTP_PORT = Number(process.env.SOUND_HTTP_PORT) || SOUND_HTTP_PORT;
/** --osc-port / SOUND_OSC_PORT win (tests); otherwise Build → Settings → Network control decides. */
const OSC_PORT_FIXED = Number(process.env.SOUND_OSC_PORT) || null;
const READONLY_DESK = process.env.SOUND_DESK_READONLY === "1";
const VERSION = process.env.SOUND_APP_VERSION || (() => {
  try {
    return (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
})();

// ---------------------------------------------------------------- log (console, file, operator screen)

const LOG_FILE = join(DATA_DIR, "sound.log");
try {
  if (statSync(LOG_FILE).size > 2_000_000) renameSync(LOG_FILE, `${LOG_FILE}.1`);
} catch {
  /* no log yet */
}
const logBook: LogBook = { lines: [] };
let pushLog: (l: { at: number; msg: string }) => void = () => {};
function log(msg: string) {
  const line = { at: Date.now(), msg };
  logBook.lines.push(line);
  if (logBook.lines.length > 300) logBook.lines.splice(0, 100);
  const stamp = new Date(line.at).toLocaleTimeString();
  console.log(`[sound ${stamp}] ${msg}`);
  try {
    appendFileSync(LOG_FILE, `${new Date(line.at).toISOString()} ${msg}\n`);
  } catch {
    /* disk full: the console still has it */
  }
  pushLog(line);
}

// A show must not stop because of one bad message.
process.on("uncaughtException", (e) => log(`unexpected error: ${e.stack ?? e.message}`));
process.on("unhandledRejection", (e) => log(`unexpected rejection: ${e instanceof Error ? e.stack ?? e.message : e}`));

// ---------------------------------------------------------------- wiring

log(`StageMics ${VERSION} starting (data: ${DATA_DIR})${READONLY_DESK ? " — desk READ-ONLY" : ""}`);
const show = loadShow(log);
const settings = loadSettings(log);

let osc: OscServer | null = null;
let http: ReturnType<typeof startHttp> | null = null;
let cloud: CloudSync | null = null;

const engine = new Engine(
  show,
  settings,
  {
    change(what) {
      http?.broadcast(what);
      if (what.settings) cloud?.reconfigure();
      if (what.show || what.runtime) cloud?.changed();
    },
    mic: (n, name, live) => osc?.mic(n, name, live),
    cue: (sceneId, cue) => osc?.cue(sceneId, cue),
    log,
  },
  VERSION,
  READONLY_DESK,
);

engine.hooks.importSources = importSources;
engine.hooks.importLiveStage = async (a) => {
  const from = String(a.from ?? "local");
  let inc;
  if (from === "bridge") inc = await fromBridge();
  else if (from === "json") {
    if (typeof a.json !== "string") throw new UserError("json is required");
    let raw: unknown;
    try {
      raw = JSON.parse(a.json);
    } catch {
      throw new UserError("That file is not JSON");
    }
    inc = parseLiveStageShow(raw, typeof a.name === "string" ? a.name : "uploaded show file");
  } else if (from === "file") {
    if (typeof a.path !== "string" || !a.path) throw new UserError("path is required");
    inc = readShowPath(a.path);
  } else {
    const src = await importSources();
    if (!src.local) throw new UserError("No LiveStage show on this computer");
    inc = readShowPath(src.local.path);
  }
  if (!inc.scenes.length) throw new UserError("That show has no scenes");
  if (a.dryRun === true) {
    const { report } = mergeImport(engine.show, inc);
    return { dryRun: true, ...report };
  }
  const { show: next, report } = mergeImport(engine.show, inc);
  engine.replaceShow(next);
  cloud?.reconfigure();
  log(`imported ${inc.scenes.length} scenes from ${inc.via}: ${report.added.length} new, ${report.updated.length} changed, ${report.removed.length} gone from LiveStage`);
  return report;
};

const refreshLan = () => {
  const next = lanAddresses();
  if (JSON.stringify(next) !== JSON.stringify(engine.rt.lan)) {
    engine.rt.lan = next;
    http?.broadcast({ show: false, settings: true, runtime: true });
  }
};
engine.rt.lan = lanAddresses();
setInterval(refreshLan, 15000).unref();

http = startHttp(engine, HTTP_PORT, logBook, log);
pushLog = (l) => http?.sendLog(l);
/** (Re)open the OSC listener from the settings. A port that is taken is reported on screen, not fatal. */
async function startOsc() {
  osc?.close();
  osc = null;
  const port = OSC_PORT_FIXED ?? engine.settings.network.oscPort;
  engine.rt.osc = { status: "off", port, error: null };
  if (engine.settings.network.oscEnabled || OSC_PORT_FIXED) {
    const s = new OscServer(engine, port, log);
    try {
      await s.ready;
      osc = s;
      engine.rt.osc = { status: "listening", port, error: null };
    } catch (e) {
      s.close();
      const msg = e instanceof Error ? e.message : String(e);
      engine.rt.osc = { status: "error", port, error: /EADDRINUSE/.test(msg) ? `UDP ${port} is in use by another program` : msg };
      log(`network control: ${engine.rt.osc.error}`);
    }
  }
  http?.broadcast({ show: false, settings: false, runtime: true });
}
engine.hooks.restartOsc = startOsc;
cloud = new CloudSync(engine, log);
cloud.reconfigure();

const url = `http://localhost:${HTTP_PORT}`;
Promise.all([new Promise((r) => http!.server.once("listening", r)), startOsc()])
  .then(() => {
    console.log(`SOUND_READY ${JSON.stringify({ url, http: HTTP_PORT, osc: engine.rt.osc.port, data: DATA_DIR, pid: process.pid })}`);
    if (process.argv.includes("--open")) openAppWindow(url, log);
  })
  .catch((e) => {
    log(`could not start: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });

// ---------------------------------------------------------------- shutdown

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  log("stopping");
  cloud?.stop();
  engine.shutdown();
  osc?.close();
  http?.close();
  setTimeout(() => process.exit(0), 300).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
