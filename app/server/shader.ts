// The link to Shader's video recorder (docs/APP.md, "Shader video recorder"; the contract both apps follow
// is shader/docs/stagemics-markers.md). Scene starts and ends and operator marks become events with a fixed
// id, kept in an outbox on disk until Shader answers "saved" or "duplicate", and posted one at a time in
// order. Shader is asked for its take every 2 s (the heartbeat). An event belongs to the take that was
// recording when it happened and is never moved to a later one. Clock probes measure this computer's clock
// against Shader's, so a marker lands on the right frame even when the two computers' clocks disagree.
//
// It only reads what the engine says is live: nothing here reaches the desk.

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { castWithMics, sceneById } from "./logic.ts";
import type { Runtime, Settings, ShaderEventInfo, ShaderStatus, SoundScene, SoundShow } from "./model.ts";
import { DATA_DIR, writeAtomic } from "./store.ts";

export const SHADER_PROTOCOL = "shader.recorder/1";
const POLL_MS = 2000;
const TIMEOUT_MS = 3000;
const PROBE_EVERY_MS = 30_000;
const PROBES = 4;
const RETRY_MS = [250, 500, 1000, 2000];
const RECENT = 30;
const OUTBOX_MAX = 1000;
const STATE_FILE = join(DATA_DIR, "shader-link.json");

type EventType = ShaderEventInfo["type"];

interface Pending {
  id: string;
  run: string;
  seq: number;
  type: EventType;
  label: string;
  /** This computer's clock (ms) when it happened. */
  at: number;
  /** The take it belongs to; null while no take was known (settled at Shader's next answer). */
  take: string | null;
  fields: Record<string, unknown>;
  audio?: { recordingId: string; recordingName: string; sample: string; sampleRate: number; edited: false };
  /** Frozen the first time it is sent, so every retry is byte-for-byte the same. */
  body?: string;
}

interface LinkState {
  senderId: string;
  /** The scene this link last saw live, its scene.enter, and the take that enter went to. */
  scene: { id: string; code: string; name: string; at: number; enterId: string; sentTo: string | null } | null;
  /** The take last seen recording. */
  take: string | null;
  outbox: Pending[];
  recent: ShaderEventInfo[];
}

interface Answer {
  recording: boolean;
  id: string | null;
  name: string | null;
  startedUtc: number | null;
  clockId: string | null;
  showRunId: string | null;
}

interface Clock {
  id: string;
  tps: bigint;
  /** Shader's ticks for an instant = utc ms · tps / 1000 + offset. */
  offset: bigint;
  uncertainty: bigint;
  probedUtc: number;
  rttMs: number;
  skewMs: number | null;
  at: number;
}

export interface ShaderHost {
  show(): SoundShow;
  rt(): Runtime;
  settings(): Settings;
  /** Where StageMics' own audio recording is, while it is writing. */
  audioAt(): { id: string; name: string; sample: number; rate: number } | null;
  version: string;
  log(m: string): void;
  changed(): void;
}

class Refused extends Error {}

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const big = (v: unknown): bigint | null => (typeof v === "string" && /^-?\d+$/.test(v) ? BigInt(v) : typeof v === "number" && Number.isSafeInteger(v) ? BigInt(v) : null);

export class ShaderLink {
  st: ShaderStatus;
  private host: ShaderHost;
  private state: LinkState;
  private run = randomUUID();
  private seq = 0;
  private answer: Answer | null = null;
  private clock: Clock | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private due = 0;
  private busy = false;
  private again = false;
  private fails = 0;
  private stopped = false;
  private lastKey = "";

  constructor(host: ShaderHost) {
    this.host = host;
    this.state = this.load();
    this.st = { state: "off", target: "", error: null, app: null, version: null, recording: null, take: null, pending: this.state.outbox.length, clock: null, lastContact: null, recent: this.state.recent };
  }

  private get cfg() {
    return this.host.settings().shader;
  }
  private get base() {
    return `http://${this.cfg.host.includes(":") ? `[${this.cfg.host}]` : this.cfg.host}:${this.cfg.port}/recorder/v1`;
  }

  // ---------------------------------------------------------------- what happens on stage

  /** Follow what is live (called after every change is applied). A restart mid-scene sends nothing new. */
  sync() {
    const show = this.host.show();
    const rt = this.host.rt();
    const sc = sceneById(show, rt.activeSceneId) ?? null;
    const cur = this.state.scene;
    if ((cur?.id ?? null) === (sc?.id ?? null)) return;
    const now = Date.now();
    if (cur) {
      const reason = sc ? "next-scene" : sceneById(show, cur.id) ? "ended" : "removed";
      this.add("scene.exit", `End of scene ${cur.code} · ${cur.name}`.slice(0, 200), now, { scene: { id: cur.id, code: cur.code, name: cur.name }, enterEventId: cur.enterId, enteredUtc: String(cur.at), reason });
    }
    if (sc) {
      const p = this.add("scene.enter", sceneLabel(sc), now, this.enterFields(sc, false));
      this.state.scene = { id: sc.id, code: sc.code, name: sc.name, at: now, enterId: p?.id ?? randomUUID(), sentTo: p?.take ?? null };
    } else this.state.scene = null;
    this.save();
    this.kick();
  }

  /** An operator marker. Returns what happened to it. */
  marker(label: string) {
    const p = this.add("marker", (label.trim() || "Mark").slice(0, 200), Date.now(), {});
    this.save();
    this.kick();
    return p ? { queued: true, take: p.take } : { queued: false, reason: this.cfg.enabled ? "Shader is not recording" : "the Shader link is off" };
  }

  private enterFields(sc: SoundScene, alreadyLive: boolean) {
    const rt = this.host.rt();
    const q = rt.activeSceneId === sc.id && rt.cue >= 0 ? sc.cues[rt.cue] : sc.cues[0];
    const n = q ? sc.cues.indexOf(q) + 1 : 0;
    return {
      scene: { id: sc.id, code: sc.code, name: sc.name },
      ...(q ? { cue: { id: q.id, number: n, label: q.label } } : {}),
      cast: castWithMics(this.host.show(), sc).map((c) => ({ id: c.char.id, name: c.char.name, mic: c.mic })),
      alreadyLive,
    };
  }

  /** Queue an event for the take recording now; null when it is not sent (link off, or Shader not recording). */
  private add(type: EventType, label: string, at: number, fields: Record<string, unknown>, withAudio = true): Pending | null {
    if (!this.cfg.enabled) return null;
    const take = this.takeNow();
    const info: ShaderEventInfo = { id: randomUUID(), type, label, at, state: "waiting" };
    if (take === "none") {
      this.remember({ ...info, state: "skipped", error: "Shader was not recording" });
      return null;
    }
    const a = withAudio ? this.host.audioAt() : null;
    const p: Pending = { id: info.id, run: this.run, seq: ++this.seq, type, label, at, take, fields, ...(a ? { audio: { recordingId: a.id, recordingName: a.name, sample: String(a.sample), sampleRate: a.rate, edited: false } } : {}) };
    this.state.outbox.push(p);
    if (this.state.outbox.length > OUTBOX_MAX) {
      const lost = this.state.outbox.shift()!;
      this.remember({ id: lost.id, type: lost.type, label: lost.label, at: lost.at, state: "rejected", error: "Too many markers waiting: the oldest was dropped" });
      this.host.log(`shader: more than ${OUTBOX_MAX} markers waiting, dropped "${lost.label}"`);
    }
    this.remember(info);
    return p;
  }

  /** The take an event made now belongs to: its id, "none" (Shader says it is not recording), or null (not known yet). */
  private takeNow(): string | null | "none" {
    const a = this.answer;
    if (!a) return null;
    if (a.recording && a.id) return a.id;
    // Not recording at its last answer: if Shader has gone quiet since, it may have started; settle it later.
    return this.st.state === "connected" ? "none" : null;
  }

  // ---------------------------------------------------------------- the loop

  configure() {
    this.answer = null;
    this.clock = null;
    this.fails = 0;
    const c = this.cfg;
    this.st.target = `${c.host}:${c.port}`;
    this.st.app = this.st.version = null;
    this.st.recording = null;
    this.st.take = null;
    this.st.clock = null;
    if (!c.enabled) {
      this.st.state = "off";
      this.st.error = null;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.publish(true);
      return;
    }
    this.st.state = "connecting";
    this.st.error = null;
    this.publish(true);
    this.kick();
  }

  /** Talk to Shader now (a new event, a settings change, "try again"). */
  kick() {
    this.schedule(0);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number) {
    if (this.stopped || !this.cfg.enabled) return;
    if (this.busy) {
      if (ms === 0) this.again = true;
      return;
    }
    const at = Date.now() + ms;
    if (this.timer && this.due <= at) return;
    if (this.timer) clearTimeout(this.timer);
    this.due = at;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, ms);
    this.timer.unref?.();
  }

  private async tick() {
    if (this.busy || !this.cfg.enabled) return;
    this.busy = true;
    this.again = false;
    let next = POLL_MS;
    try {
      await this.poll();
      if (!this.clock || this.clock.id !== this.answer?.clockId || Date.now() - this.clock.at > PROBE_EVERY_MS) await this.probe();
      this.settle();
      while (this.state.outbox[0]?.take && this.cfg.enabled) {
        if (!(await this.send(this.state.outbox[0]))) {
          next = this.retryIn ?? RETRY_MS[Math.min(this.fails++, RETRY_MS.length - 1)];
          this.retryIn = null;
          break;
        }
      }
      if (!this.state.outbox.length) this.fails = 0;
    } catch (e) {
      this.st.state = "error";
      this.st.error = e instanceof Error ? e.message : String(e);
      if (this.state.outbox.length && !(e instanceof Refused)) next = RETRY_MS[Math.min(this.fails++, RETRY_MS.length - 1)];
    } finally {
      this.busy = false;
      this.st.pending = this.state.outbox.length;
      this.publish();
      this.schedule(this.again ? 0 : next);
    }
  }

  private retryIn: number | null = null;

  private async request(method: "GET" | "POST", path: string, body?: string) {
    const headers: Record<string, string> = { "User-Agent": `StageMics/${this.host.version}`, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.cfg.key) headers.Authorization = `Bearer ${this.cfg.key}`;
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      const c = (e as { cause?: { code?: string } }).cause?.code;
      const why = c === "ECONNREFUSED" ? "nothing is listening there" : c === "EHOSTUNREACH" || c === "ENETUNREACH" ? "that computer cannot be reached" : c === "ENOTFOUND" ? "that computer name is not known" : (e as Error).name === "TimeoutError" ? "no answer within 3 s" : (e as Error).message;
      throw new Error(`Shader not answering at ${this.st.target}: ${why}`);
    }
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      /* not JSON: judged by the status code alone */
    }
    return { status: res.status, json, retryAfter: Number(res.headers.get("retry-after")) || null };
  }

  /** The heartbeat and handshake: what take Shader is recording. */
  private async poll() {
    const r = await this.request("GET", "/session");
    if (r.status === 401 || r.status === 403) throw new Refused("Shader refused the pairing key: copy it again from Shader");
    if (r.status !== 200) throw new Error(`Shader answered ${r.status}${isStr(r.json.error) ? `: ${r.json.error}` : ""}`);
    const j = r.json;
    const proto = String(j.protocol ?? "");
    if (proto !== SHADER_PROTOCOL && !proto.startsWith(`${SHADER_PROTOCOL}.`)) throw new Refused(`Shader speaks ${proto || "an unknown protocol"}, StageMics speaks ${SHADER_PROTOCOL}`);
    const recording = j.recording === true && isStr(j.recordingSessionId);
    const started = big(j.startedUtc);
    this.answer = {
      recording,
      id: recording ? (j.recordingSessionId as string) : null,
      name: isStr(j.sessionName) ? j.sessionName : null,
      startedUtc: started !== null ? Number(started) : null,
      clockId: isStr(j.sessionClockId) ? j.sessionClockId : null,
      showRunId: isStr(j.showRunId) ? j.showRunId : null,
    };
    if (this.st.state !== "connected") this.host.log(`shader: connected to ${isStr(j.app) ? j.app : "Shader"} ${isStr(j.version) ? j.version : ""} at ${this.st.target}`);
    this.st.state = "connected";
    this.st.error = null;
    this.st.app = isStr(j.app) ? j.app : "Shader";
    this.st.version = isStr(j.version) ? j.version : null;
    this.st.recording = recording;
    this.st.take = recording ? { id: this.answer.id!, name: this.answer.name, startedUtc: this.answer.startedUtc } : null;
    this.st.lastContact = Date.now();
  }

  /** NTP-style: keep the probe with the smallest uncertainty. A Shader without probes just has no clock. */
  private async probe() {
    let best: Clock | null = null;
    for (let i = 0; i < PROBES; i++) {
      const t1 = Date.now();
      let r;
      try {
        r = await this.request("POST", "/clock/probe", JSON.stringify({ t1: String(t1) }));
      } catch {
        break;
      }
      const t4 = Date.now();
      const t2 = big(r.json.t2);
      const t3 = big(r.json.t3);
      const tps = big(r.json.ticksPerSecond);
      if (r.status !== 200 || t2 === null || t3 === null || !tps || tps <= 0n || !isStr(r.json.sessionClockId)) break;
      const offset = (t2 * 1000n - BigInt(t1) * tps + (t3 * 1000n - BigInt(t4) * tps)) / 2000n;
      let unc = (BigInt(t4 - t1) * tps - (t3 - t2) * 1000n) / 2000n;
      // Date.now() counts whole milliseconds: never claim better than half of one.
      if (unc < tps / 2000n) unc = tps / 2000n;
      const utc = big(r.json.utc);
      const c: Clock = { id: r.json.sessionClockId, tps, offset, uncertainty: unc, probedUtc: t1, rttMs: t4 - t1, skewMs: utc !== null ? Number(utc) - (t1 + t4) / 2 : null, at: Date.now() };
      if (!best || c.uncertainty < best.uncertainty) best = c;
    }
    if (best) {
      this.clock = best;
      this.st.clock = { rttMs: best.rttMs, uncertaintyMs: Math.round((Number(best.uncertainty) / Number(best.tps)) * 10000) / 10, skewMs: best.skewMs !== null ? Math.round(best.skewMs) : null, at: best.at };
    }
  }

  /** After an answer: events made while no take was known, and a take that started while a scene is live. */
  private settle() {
    const a = this.answer!;
    let changed = false;
    const skew = this.clock?.skewMs ?? 0;
    for (const p of [...this.state.outbox]) {
      if (p.take) continue;
      changed = true;
      if (a.recording && a.startedUtc !== null && p.at + skew >= a.startedUtc) {
        p.take = a.id;
        if (p.id === this.state.scene?.enterId) this.state.scene.sentTo = a.id;
      } else {
        this.state.outbox.splice(this.state.outbox.indexOf(p), 1);
        this.remember({ id: p.id, type: p.type, label: p.label, at: p.at, state: "skipped", error: "Shader was not recording" });
      }
    }
    if (a.recording && a.id !== this.state.take) {
      this.state.take = a.id;
      changed = true;
      const s = this.state.scene;
      const sc = s ? sceneById(this.host.show(), s.id) : null;
      if (s && sc && s.sentTo !== a.id) {
        // The take started mid-scene: it gets the scene with its real (earlier) start time.
        const p = this.add("scene.enter", sceneLabel(sc), s.at, this.enterFields(sc, true), false);
        if (p) {
          s.enterId = p.id;
          s.sentTo = p.take;
        }
      }
    }
    if (changed) this.save();
  }

  /** Post one event. True when Shader has it (saved or duplicate) or refused it for good; false to retry. */
  private async send(p: Pending): Promise<boolean> {
    if (!p.body) {
      p.body = JSON.stringify(this.envelope(p));
      this.save();
    }
    let r;
    try {
      r = await this.request("POST", `/sessions/${encodeURIComponent(p.take!)}/events`, p.body);
    } catch (e) {
      this.st.state = "error";
      this.st.error = e instanceof Error ? e.message : String(e);
      return false;
    }
    const status = String(r.json.status ?? "");
    const err = isStr(r.json.error) ? r.json.error : null;
    const code = isStr(r.json.code) ? r.json.code : null;
    if ((r.status === 201 || r.status === 200) && status !== "rejected") {
      this.done(p, status === "duplicate" ? "duplicate" : "saved");
      return true;
    }
    if (r.status === 401 || r.status === 403) throw new Refused("Shader refused the pairing key: copy it again from Shader");
    if (r.status === 429 || r.status >= 500) {
      this.retryIn = r.status === 429 ? (r.retryAfter ?? 2) * 1000 : null;
      this.st.error = `Shader answered ${r.status}${err ? `: ${err}` : ""}; trying again`;
      return false;
    }
    const why = code === "NO_ACTIVE_SESSION" || code === "UNKNOWN_SESSION" || ((r.status === 404 || r.status === 409) && code !== "EVENT_ID_CONFLICT") ? "Shader no longer has that take" : err ?? `Shader answered ${r.status}`;
    this.host.log(`shader: "${p.label}" refused (${r.status}${code ? ` ${code}` : ""}): ${err ?? why}`);
    this.done(p, "rejected", why);
    return true;
  }

  private envelope(p: Pending) {
    const c = this.clock;
    return {
      protocol: SHADER_PROTOCOL,
      eventId: p.id,
      senderId: this.state.senderId,
      senderRunId: p.run,
      sequence: String(p.seq),
      recordingSessionId: p.take,
      ...(this.answer?.showRunId && this.answer.id === p.take ? { showRunId: this.answer.showRunId } : {}),
      type: p.type,
      label: p.label,
      ...p.fields,
      time: {
        domain: "utc",
        utc: String(p.at),
        clockSource: "stagemics-host",
        ...(c ? { clock: { sessionClockId: c.id, ticksPerSecond: String(c.tps), offsetTicks: String(c.offset), uncertaintyTicks: String(c.uncertainty), probedUtc: String(c.probedUtc) } } : {}),
      },
      ...(p.audio ? { audio: p.audio } : {}),
      scope: "all-recorded-inputs",
    };
  }

  private done(p: Pending, state: ShaderEventInfo["state"], error?: string) {
    this.state.outbox.splice(this.state.outbox.indexOf(p), 1);
    this.remember({ id: p.id, type: p.type, label: p.label, at: p.at, state, ...(error ? { error } : {}) });
    this.save();
  }

  // ---------------------------------------------------------------- bookkeeping

  private remember(info: ShaderEventInfo) {
    const r = this.state.recent.filter((x) => x.id !== info.id);
    r.unshift(info);
    this.state.recent = r.slice(0, RECENT);
    this.st.recent = this.state.recent;
    this.st.pending = this.state.outbox.length;
    this.publish(true);
  }

  /** Tell the screens when something they show changed (not on every heartbeat). */
  private publish(force = false) {
    const { lastContact: _, ...rest } = this.st;
    const key = JSON.stringify(rest);
    if (!force && key === this.lastKey) return;
    this.lastKey = key;
    this.host.changed();
  }

  status() {
    return { ...this.st, outbox: this.state.outbox.map((p) => ({ id: p.id, type: p.type, label: p.label, at: p.at, take: p.take })) };
  }

  private load(): LinkState {
    try {
      if (existsSync(STATE_FILE)) {
        const j = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<LinkState>;
        if (j && isStr(j.senderId)) return { senderId: j.senderId, scene: j.scene ?? null, take: j.take ?? null, outbox: Array.isArray(j.outbox) ? j.outbox : [], recent: Array.isArray(j.recent) ? j.recent : [] };
      }
    } catch {
      /* unreadable: start a fresh link (Shader de-duplicates by event id) */
    }
    return { senderId: `stagemics-${randomBytes(4).toString("hex")}`, scene: null, take: null, outbox: [], recent: [] };
  }

  private save() {
    try {
      writeAtomic(STATE_FILE, JSON.stringify(this.state));
    } catch (e) {
      this.host.log(`shader: could not save the marker outbox: ${e instanceof Error ? e.message : e}`);
    }
  }
}

function sceneLabel(sc: SoundScene) {
  return `Scene ${sc.code} · ${sc.name}`.slice(0, 200);
}
