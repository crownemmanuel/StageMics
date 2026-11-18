#!/usr/bin/env node
// End-to-end check of StageMics against the pretend desk (scripts/fake-dlive.ts). Never touches a real
// desk: it starts its own fake desk, its own service (scratch data folder, test ports) and drives it the way
// LiveStage (OSC), the operator (API), the backstage page (WebSocket), the desk surface (a second TCP client)
// and an agent (MCP) would. The Dante input is the built-in test signal: it checks the no-signal alerts, a
// recording (per character, following the mutes, across a mic change), its export and a crash mid-recording.
// A pretend Shader (scripts/fake-shader.ts) checks the scene markers sent to the video recorder.
//
//   node app/check.ts [--keep]   (--keep leaves the scratch folder for a look)

import { spawn, type ChildProcess } from "node:child_process";
import { createSocket } from "node:dgram";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DliveParser, dliveMute, type DliveEvent } from "../shared/dlive.ts";
import { SOUND_OSC, SOUND_OSC_REPLY } from "../shared/soundProtocol.ts";
import { decodeOsc, encodeOsc, type OscMessage } from "./server/osc.ts";
import { readWavInfo } from "./server/wav.ts";
import { FakeShader } from "../scripts/fake-shader.ts";

const here = dirname(fileURLToPath(import.meta.url));
// Override with SOUND_CHECK_HTTP / _OSC / _DESK when something else on this computer holds these ports.
const DESK_PORT = Number(process.env.SOUND_CHECK_DESK ?? 51399);
const HTTP = Number(process.env.SOUND_CHECK_HTTP ?? 1460);
const OSC = Number(process.env.SOUND_CHECK_OSC ?? 1461);
const SHADER = Number(process.env.SOUND_CHECK_SHADER ?? 1462);
let fake: FakeShader | null = null;
const data = mkdtempSync(join(tmpdir(), "sound-check-"));
const recDir = join(data, "rec");
writeFileSync(join(data, "settings.json"), JSON.stringify({ version: 1, desk: { host: "127.0.0.1", port: DESK_PORT, baseChannel: 12, mode: "desk" }, audio: { source: "test" }, recorder: { folder: recDir } }));

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return true;
    await sleep(50);
  }
  return false;
}

const procs: ChildProcess[] = [];
function start(file: string, args: string[], env: Record<string, string> = {}) {
  const p = spawn(process.execPath, [file, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  procs.push(p);
  p.stdout!.on("data", () => {});
  p.stderr!.on("data", (d) => process.env.CHECK_VERBOSE && process.stderr.write(d));
  return p;
}
const startDesk = () => start(join(here, "..", "scripts", "fake-dlive.ts"), ["--port", String(DESK_PORT), "--quiet"]);

// ---------------------------------------------------------------- the pieces

let desk = startDesk();
await sleep(400);
const startService = () => start(join(here, "server", "main.ts"), [], { SOUND_DATA_DIR: data, SOUND_HTTP_PORT: String(HTTP), SOUND_OSC_PORT: String(OSC) });
let service = startService();

async function api(cmd: string, args: Record<string, unknown> = {}) {
  const r = await fetch(`http://127.0.0.1:${HTTP}/api/cmd`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cmd, args }) });
  return (await r.json()) as { ok: boolean; result?: any; error?: string };
}
const status = async () => (await (await fetch(`http://127.0.0.1:${HTTP}/api/status`)).json()) as { desk: { status: string }; mics: { mic: number; live?: boolean; deskName?: string; fx?: string; waiting?: boolean }[]; cue: { n: number } | null };
const micLive = async (n: number) => (await status()).mics.find((m) => m.mic === n)?.live;
const signal = async (n: number) => ((await status()) as unknown as { mics: { mic: number; signal?: boolean }[] }).mics.find((m) => m.mic === n)?.signal;
const answers = () => until(async () => {
  try {
    return (await fetch(`http://127.0.0.1:${HTTP}/api/ping`)).ok;
  } catch {
    return false;
  }
}, 5000);

/** Is there sound (any non-zero sample) in [from, to) seconds of a mono 24-bit WAV? `all`: in every 20 ms of it. */
async function wavSound(path: string, from: number, to: number, all = false) {
  const info = await readWavInfo(path);
  const a = Math.max(0, Math.floor(from * info.rate));
  const b = Math.min(info.frames, Math.ceil(to * info.rate));
  if (b <= a) return false;
  const buf = Buffer.alloc((b - a) * 3);
  const fd = openSync(path, "r");
  readSync(fd, buf, 0, buf.length, info.dataOffset + a * 3);
  closeSync(fd);
  const win = Math.round(info.rate * 0.02) * 3;
  let windows = 0;
  let loud = 0;
  for (let w = 0; w < buf.length; w += win) {
    windows++;
    for (let i = w; i < Math.min(buf.length, w + win); i++) if (buf[i]) {
      loud++;
      break;
    }
  }
  return all ? loud === windows : loud > 0;
}
/** "Mary" → <dir>/NN Mary.wav (exports number the files in show order). */
const exported = (dir: string, name: string) => {
  const f = existsSync(dir) ? readdirSync(dir).find((x) => x.endsWith(` ${name}.wav`)) : undefined;
  return f ? join(dir, f) : join(dir, `?? ${name}.wav`);
};
const wavSeconds = async (path: string) => {
  const i = await readWavInfo(path);
  return i.frames / i.rate;
};

/** "The desk surface": a second client that sees every change the app makes (the desk relays them). */
const surfaceEvents: DliveEvent[] = [];
let surface: Socket = new Socket();
function connectSurface() {
  surface = new Socket();
  const parser = new DliveParser(12);
  surface.on("data", (b: Buffer) => surfaceEvents.push(...parser.push(b)));
  surface.on("error", () => {});
  surface.connect(DESK_PORT, "127.0.0.1");
}
connectSurface();
const sawMute = (input: number, muted: boolean) => surfaceEvents.some((e) => e.type === "mute" && e.channel.kind === "input" && e.channel.number === input && e.muted === muted);

/** "LiveStage": OSC over UDP, collecting replies. */
const replies: OscMessage[] = [];
const udp = createSocket("udp4");
udp.on("message", (b) => replies.push(...decodeOsc(b)));
await new Promise<void>((r) => udp.bind(0, "127.0.0.1", () => r()));
const osc = (address: string, ...args: (string | number)[]) => udp.send(encodeOsc(address, args), OSC, "127.0.0.1");

try {
  ok("service answers", await answers());
  ok("desk connected", await until(async () => (await status()).desk.status === "connected", 5000));
  ok("desk names read (mic 1 = In 77 Drama1, mic 12 = Dram12)", await until(async () => {
    const s = await status();
    return s.mics[0].deskName === "Drama1" && s.mics[11].deskName === "Dram12";
  }));
  ok("mic state read from the desk (all muted)", await until(async () => (await status()).mics.every((m) => m.live === false)));

  // ---- OSC from LiveStage
  osc(SOUND_OSC.ping, 1);
  ok("/sound/ping → /sound/hello", await until(() => replies.some((m) => m.address === SOUND_OSC_REPLY.hello && m.args[0] === 1 && m.args[2] === 1)));
  osc(SOUND_OSC.sceneActivate, "demo_7");
  ok("/sound/scene/activate demo_7: Mary + Martha live on the desk", await until(() => sawMute(77, false) && sawMute(80, false)));
  ok("… Gabriel stays muted", !sawMute(79, false));
  ok("… /sound/state/mic replies (1 Mary 1)", await until(() => replies.some((m) => m.address === SOUND_OSC_REPLY.mic && m.args[0] === 1 && m.args[1] === "Mary" && m.args[2] === 1)));
  ok("… /sound/state/cue demo_7 1", replies.some((m) => m.address === SOUND_OSC_REPLY.cue && m.args[0] === "demo_7" && m.args[1] === 1));

  osc(SOUND_OSC.cueGo, "demo_7", 2);
  ok("/sound/cue/go demo_7 2: Gabriel live, Martha muted", await until(() => sawMute(79, false) && sawMute(80, true)));
  ok("… Heaven fades In 79 into FX send 3 up to 0 dB", await until(() => surfaceEvents.some((e) => e.type === "send" && e.from.number === 79 && e.to.kind === "monoFxSend" && e.to.number === 3 && e.level === 0x6b), 3500));
  ok("… and FX send 2 to −5 dB", await until(() => surfaceEvents.some((e) => e.type === "send" && e.from.number === 79 && e.to.number === 2 && e.level === 0x61)));

  // ---- someone on the desk surface
  surface.write(Uint8Array.from(dliveMute(11, { kind: "input", number: 77 }, true)));
  ok("mute on the desk surface → app shows Mary muted", await until(async () => (await micLive(1)) === false));
  ok("… and tells LiveStage (1 Mary 0)", await until(() => replies.some((m) => m.address === SOUND_OSC_REPLY.mic && m.args[0] === 1 && m.args[2] === 0)));
  osc(SOUND_OSC.restore);
  ok("/sound/restore puts Mary back live", await until(async () => (await micLive(1)) === true));

  osc(SOUND_OSC.mic, "martha", 1);
  ok("/sound/mic martha 1 (by name)", await until(async () => (await micLive(4)) === true));
  osc(SOUND_OSC.mic, "4", 0);
  ok("/sound/mic 4 0 (by number)", await until(async () => (await micLive(4)) === false));
  osc(SOUND_OSC.fx, "Gabriel", "Echo", "full");
  ok("/sound/fx Gabriel Echo full", await until(async () => (await status()).mics[2].fx === "Echo"));
  ok("… FX send 3 at +6 dB", await until(() => surfaceEvents.some((e) => e.type === "send" && e.from.number === 79 && e.to.number === 3 && e.level === 0x77), 2500));
  ok("… HALL send fades back to −inf", await until(() => surfaceEvents.some((e) => e.type === "send" && e.from.number === 79 && e.to.number === 2 && e.level === 0), 3500));
  osc(SOUND_OSC.fx, "3", "none");
  ok("/sound/fx 3 none: DELAY send back to −inf", await until(() => surfaceEvents.filter((e) => e.type === "send" && e.from.number === 79 && e.to.number === 3).at(-1)?.type === "send" && (surfaceEvents.filter((e) => e.type === "send" && e.from.number === 79 && e.to.number === 3).at(-1) as { level: number }).level === 0, 3500));

  osc(SOUND_OSC.cueNext);
  ok("/sound/cue/next → Q3", await until(async () => (await status()).cue?.n === 3));
  const bad = await api("cue.go", { scene: "demo_7", cue: 9 });
  ok("a cue that does not exist is refused", !bad.ok && /no cue 9/.test(bad.error ?? ""), bad.error);

  // ---- stray mic + panic
  surface.write(Uint8Array.from(dliveMute(11, { kind: "input", number: 88 }, false)));
  ok("mic 12 opened on the surface shows live", await until(async () => (await micLive(12)) === true));
  osc(SOUND_OSC.panic);
  ok("/sound/panic: every mic muted on the desk", await until(async () => (await status()).mics.every((m) => m.live === false)));
  ok("… the surface saw In 88 muted", sawMute(88, true));

  osc(SOUND_OSC.sceneActivate, "demo_12");
  await until(async () => (await status()).cue?.n === 1);
  osc(SOUND_OSC.sceneEnd);
  ok("/sound/scene/end", await until(async () => (await status()).cue === null));

  // ---- backstage page (WebSocket, LAN role)
  const bs = new WebSocket(`ws://127.0.0.1:${HTTP}/ws?role=backstage`);
  const bsMsgs: any[] = [];
  bs.on("message", (m) => bsMsgs.push(JSON.parse(String(m))));
  await new Promise((r) => bs.once("open", r));
  ok("backstage gets the scenes", await until(() => bsMsgs.some((m) => m.t === "backstage" && m.view.scenes.length > 3)));
  bs.send(JSON.stringify({ t: "cmd", id: 1, cmd: "assign", args: { scene: "demo_7", character: "ch_mary", mic: 3 } }));
  ok("backstage assign: Mary → mic 3 swaps with Gabriel", await until(() => bsMsgs.some((m) => m.t === "backstage" && m.view.scenes.find((s: any) => s.id === "demo_7")?.mics.ch_mary === 3 && m.view.scenes.find((s: any) => s.id === "demo_7")?.mics.ch_gabriel === 1)));
  bs.send(JSON.stringify({ t: "cmd", id: 2, cmd: "panic", args: {} }));
  ok("backstage cannot run panic", await until(() => bsMsgs.some((m) => m.t === "res" && m.id === 2 && !m.ok)));
  bs.send(JSON.stringify({ t: "cmd", id: 3, cmd: "scene.confirm", args: { scene: "demo_7", by: "Sam" } }));
  ok("backstage confirm", await until(() => bsMsgs.some((m) => m.t === "backstage" && m.view.scenes.find((s: any) => s.id === "demo_7")?.checked?.by === "Sam")));
  bs.close();
  const bsOp = new WebSocket(`ws://127.0.0.1:${HTTP}/ws?role=operator`);
  ok("operator WebSocket from this computer is allowed", await new Promise((r) => { bsOp.once("open", () => r(true)); bsOp.once("error", () => r(false)); }));
  bsOp.close();

  // ---- mapping from desk names
  await api("mics.set", { mics: [{ n: 1, channel: 50 }] });
  const det = await api("mics.detect");
  ok("detect from desk maps mic 1 back to In 77 (Drama1)", det.ok && det.result.changed.some((c: any) => c.mic === 1 && c.channel === 77), JSON.stringify(det.result ?? det.error));

  // ---- the desk goes away and comes back
  desk.kill();
  ok("desk loss is noticed", await until(async () => (await status()).desk.status !== "connected", 3000));
  await api("mic", { who: "Joseph", live: true });
  ok("a mic change while the desk is away waits", (await status()).mics[1].waiting === true);
  desk = startDesk();
  ok("desk reconnects", await until(async () => (await status()).desk.status === "connected", 12000));
  ok("… the waiting change goes out (Joseph live on the new desk)", await until(async () => (await micLive(2)) === true, 3000));
  connectSurface();

  // ---- Dante input (test signal): signal per mic, a pack switched off
  ok("Dante test input running", await until(async () => ((await (await fetch(`http://127.0.0.1:${HTTP}/api/state`)).json()) as any).runtime.audio.status === "running", 4000));
  ok("… every mic has signal", await until(async () => (await signal(1)) === true && (await signal(12)) === true, 3000));
  await api("audio.testSignal", { channel: 8, on: false });
  ok("a pack switched off shows no signal within 3 s (mic 8)", await until(async () => (await signal(8)) === false, 3500));
  ok("… and goes to the backstage page", await new Promise<boolean>((r) => {
    const w = new WebSocket(`ws://127.0.0.1:${HTTP}/ws?role=backstage`);
    w.on("message", (m) => {
      const v = JSON.parse(String(m));
      if (v.t === "backstage") r(v.view.signal?.["8"] === false);
      w.close();
    });
    w.on("error", () => r(false));
  }));
  await api("audio.testSignal", { channel: 8, on: true });
  ok("… and back on", await until(async () => (await signal(8)) === true, 2000));

  // ---- the recorder: Mary is on mic 1 in scene 4 and (since the backstage swap) mic 3 in scene 7
  osc(SOUND_OSC.panic);
  await until(async () => (await status()).mics.every((m) => m.live === false));
  const r0 = await api("rec.start", { name: "Check" });
  ok("record", r0.ok && r0.result.audio === true, JSON.stringify(r0.error ?? ""));
  await sleep(500);
  osc(SOUND_OSC.sceneActivate, "demo_4");
  await until(async () => (await micLive(8)) === true);
  await sleep(1200);
  osc(SOUND_OSC.sceneActivate, "demo_7");
  await until(async () => (await micLive(3)) === true && (await micLive(8)) === false);
  await sleep(1200);
  osc(SOUND_OSC.cueGo, "demo_7", 2);
  await until(async () => (await micLive(1)) === true);
  const rs = (await api("rec.status")).result;
  ok("… writing Mary and Gabriel now", ["Mary", "Gabriel"].every((n) => rs.writingNow.some((w: any) => w.track === n)) && rs.lastWriteSecondsAgo !== null && rs.lastWriteSecondsAgo < 1, JSON.stringify(rs.writingNow));
  await sleep(1000);
  await api("rec.mark", { label: "check mark" });
  osc(SOUND_OSC.sceneEnd);
  await sleep(600);
  const stop = await api("rec.stop");
  ok("stop", stop.ok && stop.result.segments >= 5, JSON.stringify(stop.result ?? stop.error));
  const ses = (await api("rec.session", { session: r0.result.id })).result as { rate: number; length: number; segments: { track: string; mic: number; start: number; length: number; open: boolean }[]; scenes: { scene: string; start: number; end: number }[]; markers: { kind: string; at: number; label: string }[]; state: string };
  const R = ses.rate;
  ok("… session saved as stopped, nothing left open", ses.state === "stopped" && ses.segments.every((g) => !g.open && g.length > 0));
  ok("… Mary's track follows her from mic 1 to mic 3", [1, 3].every((m) => ses.segments.some((g) => g.track === "char:ch_mary" && g.mic === m)));
  ok("… Gabriel's track comes from mic 1 in scene 7", ses.segments.some((g) => g.track === "char:ch_gabriel" && g.mic === 1));
  ok("… nobody muted was written (no Joseph, no Innkeeper)", !ses.segments.some((g) => g.track === "char:ch_joseph" || g.track === "char:ch_innkeeper" || g.track.startsWith("mic:")));
  const s4 = ses.scenes.find((x) => x.scene === "demo_4")!;
  const s7 = ses.scenes.find((x) => x.scene === "demo_7")!;
  const q2 = ses.markers.find((m) => m.kind === "cue" && m.label.startsWith("7 Q2"))!;
  ok("… scenes and cues on the timeline", !!s4 && !!s7 && !!q2 && ses.markers.some((m) => m.kind === "mark"));
  const ex = await api("rec.export", { session: r0.result.id, scope: "show" });
  const ex7 = await api("rec.export", { session: r0.result.id, scope: "demo_7" });
  ok("export the full show and scene 7", ex.ok && ex7.ok, ex.error ?? ex7.error);
  ok("… finished", await until(async () => {
    const st = (await api("rec.status")).result;
    return st.exports.filter((e: any) => e.session === r0.result.id).every((e: any) => e.state === "done") && st.exports.length >= 2;
  }, 8000));
  const full = join(recDir, r0.result.id, "Export", "Full show");
  const files = ["Mary", "Gabriel", "Martha", "Elizabeth"].map((n) => exported(full, n));
  ok("… one file per person who was live", files.every((f) => existsSync(f)) && readdirSync(full).filter((f) => f.endsWith(".wav")).length === 4, readdirSync(full).join(", "));
  const len = ses.length / R;
  const lens = await Promise.all(files.filter(existsSync).map(wavSeconds));
  ok("… every file as long as the recording", lens.every((l) => Math.abs(l - len) < 0.001), `${lens.map((l) => l.toFixed(3)).join(", ")} vs ${len.toFixed(3)}`);
  const t = (f: number) => f / R;
  const [mary, gabriel, martha, eliz] = files;
  if (files.every((f) => existsSync(f))) {
    ok("… Mary has sound in scene 4 and in scene 7", (await wavSound(mary, t(s4.start) + 0.3, t(s7.start) - 0.1, true)) && (await wavSound(mary, t(s7.start) + 0.3, t(s7.end) - 0.1, true)));
    ok("… Gabriel silent until his cue, then sound", !(await wavSound(gabriel, 0, t(q2.at) - 0.35)) && (await wavSound(gabriel, t(q2.at) + 0.2, t(s7.end) - 0.1, true)));
    ok("… Martha silent after she was muted in Q2", (await wavSound(martha, t(s4.start) + 0.3, t(q2.at) - 0.1, true)) && !(await wavSound(martha, t(q2.at) + 0.45, len)));
    ok("… Elizabeth only in scene 4", (await wavSound(eliz, t(s4.start) + 0.3, t(s7.start) - 0.1, true)) && !(await wavSound(eliz, t(s7.start) + 0.45, len)) && !(await wavSound(eliz, 0, t(s4.start) - 0.35)));
  }
  const sc7 = join(recDir, r0.result.id, "Export", "Scene 7 - Gabriel at the Well");
  ok("… scene 7 on its own, as long as the scene", existsSync(exported(sc7, "Mary")) && Math.abs((await wavSeconds(exported(sc7, "Mary"))) - t(s7.end - s7.start)) < 0.001 && !existsSync(exported(sc7, "Elizabeth")));
  ok("… with markers for the editor", readFileSync(join(full, "markers.csv"), "utf8").includes("check mark"));

  // ---- import from a LiveStage show file (merge keeps cues)
  const show = {
    name: "Test show",
    groups: [{ id: "g1", name: "Prologue" }],
    scenes: [
      { id: "scene_a", name: "Prologue 1", groupId: "g1" },
      { id: "scene_b", name: "Prologue 2", groupId: "g1" },
      { id: "scene_c", name: "Scene 1" },
    ],
  };
  const imp = await api("import.livestage", { from: "json", json: JSON.stringify(show) });
  ok("import a LiveStage show file", imp.ok && imp.result.added.join() === "1.1,1.2,2", JSON.stringify(imp.result ?? imp.error));
  await api("scene.cast", { scene: "scene_c", cast: ["ch_mary"] });
  await api("cue.add", { scene: "scene_c", label: "Hello" });
  show.scenes = [show.scenes[2], { id: "scene_d", name: "Scene 2" }] as typeof show.scenes;
  const re = await api("import.livestage", { from: "json", json: JSON.stringify(show) });
  ok("re-import merges (1 new, 2 gone, cues kept)", re.ok && re.result.added.length === 1 && re.result.removed.length === 2, JSON.stringify(re.result ?? re.error));
  const list = (await api("scenes.list")).result as { id: string; code: string; cues: string[]; removed?: boolean }[];
  ok("… scene_c kept its cue and is now scene 1", list.find((s) => s.id === "scene_c")?.cues[0] === "Q1 Hello" && list.find((s) => s.id === "scene_c")?.code === "1");
  const local = join(homedir(), "Library", "Application Support", "org.salvation.livestudio", "project.json");
  if (existsSync(local)) {
    const real = await api("import.livestage", { from: "json", json: readFileSync(local, "utf8"), dryRun: true });
    ok("dry run against this computer's LiveStage show", real.ok, real.ok ? `${real.result.added.length} scenes would be added` : real.error);
  }

  // ---- Shader's video recorder gets every scene start and end
  fake = new FakeShader({ key: "check-key" });
  await fake.listen(SHADER);
  const take1 = fake.startTake("Check take");
  const evs = (type?: string) => fake!.events.map((e) => e.body as any).filter((b) => !type || b.type === type);
  const shader = async () => (await api("shader.status")).result;
  await api("settings.shader", { enabled: true, host: "127.0.0.1", port: SHADER, key: "wrong" });
  ok("Shader: a wrong pairing key is shown", await until(async () => /pairing key/.test((await shader()).error ?? ""), 4000));
  await api("settings.shader", { key: "check-key" });
  ok("… right key: connected, recording, clock measured", await until(async () => {
    const s = await shader();
    return s.state === "connected" && s.recording === true && s.take?.name === "Check take" && !!s.clock;
  }, 4000));
  const t0 = Date.now();
  await api("scene.activate", { scene: "scene_c" });
  ok("… scene start arrives", await until(() => evs("scene.enter").length === 1));
  const e1 = evs("scene.enter")[0];
  ok("… with the scene, cue, cast, take and the time it happened", e1?.scene?.id === "scene_c" && e1.cue?.label === "Hello" && e1.cast?.some((c: any) => c.name === "Mary" && c.mic === 1) && e1.recordingSessionId === take1 && Math.abs(Number(e1.time.utc) - t0) < 1000 && e1.alreadyLive === false, JSON.stringify(e1));
  const at1 = BigInt(e1.time.utc) * 1_000_000n + BigInt(e1.time.clock?.offsetTicks ?? 0);
  const want1 = fake.ticks() - BigInt(Date.now() - Number(e1.time.utc)) * 1_000_000n;
  ok("… its clock offset puts it on Shader's clock (within 20 ms)", !!e1.time.clock && (at1 > want1 ? at1 - want1 : want1 - at1) < 20_000_000n, `${Number(at1 - want1) / 1e6} ms off`);
  await api("cue.add", { scene: "scene_d", label: "Start" });
  await api("scene.activate", { scene: "scene_d" });
  ok("… switching scenes: the exit, then the next scene's start, same time", await until(() => evs().length === 3) && evs()[1].type === "scene.exit" && evs()[1].reason === "next-scene" && evs()[1].enterEventId === e1.eventId && evs()[2].type === "scene.enter" && evs()[2].scene.id === "scene_d" && Number(evs()[1].sequence) < Number(evs()[2].sequence) && evs()[1].time.utc === evs()[2].time.utc);
  await fake.close();
  const tEnd = Date.now();
  await api("scene.end");
  ok("… Shader away: shown, and the scene end waits on disk", await until(async () => {
    const s = await shader();
    return s.state === "error" && s.pending === 1;
  }, 4000));
  await sleep(1500);
  fake.loseAcks = 1;
  await fake.listen(SHADER);
  ok("… Shader back: delivered once (its lost answer retried as a duplicate) with the time it happened", await until(async () => (await shader()).pending === 0 && evs("scene.exit").length === 2, 6000) && Math.abs(Number(evs("scene.exit")[1].time.utc) - tEnd) < 500 && evs("scene.exit")[1].reason === "ended" && (await shader()).recent[0].state === "duplicate");
  fake.stopTake();
  await until(async () => (await shader()).recording === false, 4000);
  await api("scene.activate", { scene: "scene_c" });
  ok("… Shader not recording: nothing sent, shown as skipped", await until(async () => (await shader()).recent[0]?.state === "skipped") && evs().length === 4);
  await sleep(300);
  const take2 = fake.startTake("Second take");
  ok("… a take started mid-scene gets that scene with its real, earlier start", await until(() => evs().some((e) => e.recordingSessionId === take2 && e.type === "scene.enter" && e.alreadyLive === true && e.scene.id === "scene_c" && Number(e.time.utc) < fake!.take!.startedUtc), 4000), JSON.stringify({ take: fake.take, events: evs().slice(3).map((e) => [e.type, e.scene?.id, e.recordingSessionId, e.alreadyLive, e.time.utc]), link: (await shader()).recent.slice(0, 3) }));
  const mk = await api("shader.mark", { label: "check video mark" });
  ok("… an operator marker", mk.ok && (await until(() => evs("marker").some((e) => e.label === "check video mark" && e.recordingSessionId === take2))));

  // ---- MCP
  const client = new Client({ name: "sound-check", version: "1.0.0" });
  const env = Object.fromEntries(Object.entries({ ...process.env, SOUND_HTTP_PORT: String(HTTP) }).filter((e): e is [string, string] => typeof e[1] === "string"));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(here, "mcp.ts")], env, stderr: "ignore" }));
  const { tools } = await client.listTools();
  ok("MCP tools", ["status", "list_scenes", "activate_scene", "cue_go", "next_cue", "end_scene", "mic", "fx", "panic", "recorder_status", "start_recording", "stop_recording", "export_recording", "video_recorder_status", "mark_video"].every((n) => tools.some((t) => t.name === n)), tools.map((t) => t.name).join(", "));
  ok("MCP marks stop_recording destructive, recorder_status read-only", !!tools.find((t) => t.name === "stop_recording")?.annotations?.destructiveHint && !!tools.find((t) => t.name === "recorder_status")?.annotations?.readOnlyHint);
  ok("MCP marks panic destructive and live", !!tools.find((t) => t.name === "panic")?.annotations?.destructiveHint && !!tools.find((t) => t.name === "panic")?.annotations?.openWorldHint);
  const st = (await client.callTool({ name: "status", arguments: {} })) as { content: { text: string }[]; isError?: boolean };
  ok("MCP status", !st.isError && JSON.parse(st.content[0].text).desk.status === "connected");
  const mic = (await client.callTool({ name: "mic", arguments: { who: "Mary", live: false } })) as { isError?: boolean };
  ok("MCP mic Mary muted", !mic.isError && (await micLive(1)) === false);
  await client.close();

  // ---- the service dies mid-recording (kill -9) and comes back (scene_c is still live from the Shader checks)
  await api("scene.activate", { scene: "scene_c" });
  const enters = evs("scene.enter").length;
  ok("Mary live in scene_c", await until(async () => (await micLive(1)) === true));
  const c0 = await api("rec.start", { name: "Crash" });
  await sleep(1500);
  service.kill("SIGKILL");
  await sleep(300);
  const before = JSON.parse(readFileSync(join(recDir, c0.result.id, "session.json"), "utf8")) as { state: string; segments: { open: boolean }[] };
  ok("killed while recording: a segment was open", before.state === "recording" && before.segments.some((g) => g.open));
  service = startService();
  ok("service back", await answers());
  ok("… the recording carries on by itself", await until(async () => {
    const st = (await api("rec.status")).result;
    return st.recording && st.session?.id === c0.result.id && !!st.resumed;
  }, 5000));
  ok("… and follows the desk again (Mary written)", await until(async () => ((await api("rec.status")).result.writingNow as { track: string }[]).some((w) => w.track === "Mary"), 8000));
  const after = (await api("rec.session", { session: c0.result.id })).result as { rate: number; segments: { file: string; length: number; recovered?: boolean }[] };
  const rec1 = after.segments.find((g) => g.recovered);
  ok("… the cut-off segment was repaired from the disk", !!rec1 && rec1.length > after.rate && (await readWavInfo(join(recDir, c0.result.id, "segments", rec1.file))).frames === rec1.length, JSON.stringify(rec1));
  const c1 = await api("rec.stop");
  ok("… and stops cleanly", c1.ok && c1.result.stopped === c0.result.id);
  ok("… Shader link back after the crash, and scene_c not sent again", await until(async () => (await shader()).state === "connected", 5000) && (await sleep(2500), evs("scene.enter").length === enters));
} catch (e) {
  failures++;
  console.log(`FAIL ${e instanceof Error ? e.stack : e}`);
} finally {
  for (const p of procs) p.kill("SIGTERM");
  await fake?.close();
  surface.destroy();
  udp.close();
  await sleep(400);
  if (!process.argv.includes("--keep")) rmSync(data, { recursive: true, force: true });
  else console.log(`scratch data: ${data}`);
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
