// The Dante audio input: reads the mic channels from the Dante Virtual Soundcard (through the native helper,
// native/audio) or from a built-in test signal, and turns them into meters, "no signal" flags and blocks for
// the recorder. It never writes to the desk.
//
//   DVS on this computer ─ CoreAudio / WASAPI ─ stagemics-audio (stdout packets) ─ AudioInput ─┬─ meters, signal
//                                                                                              └─ Recorder.block()
//
// The helper is restarted with back-off if it stops (device unplugged, DVS restarted), and killed if no audio
// arrives for 2 s. Gaps are counted, never hidden: the recorder keeps its timeline right through them.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AudioSettings, AudioStatus } from "./model.ts";

const MAGIC = 0x31414d53;
const HEADER = 16;
const TEST_RATE = 48000;
const METER_MS = 100;
/** Below the no-signal level this long → "no signal". */
const NO_SIGNAL_MS = 2000;
const WATCHDOG_MS = 2000;
/** The helper must have the device open by then (a hung driver, a permission prompt nobody answers). */
const START_MS = 10000;
/** A packet header asking for more than this is not one of ours. */
const MAX_PACKET = 16 * 1024 * 1024;
const SILENT_MS = 5000;

export interface AudioDevice {
  name: string;
  channels: number;
  rates: number[];
  defaultRate: number;
  default: boolean;
}

/** What the input hands on. `data[k]` is Dante channel `channels[k]`. */
export interface AudioListener {
  /** Audio (re)started: a new run. */
  run(rate: number, channels: number[], source: string): void;
  block(data: Float32Array[], frames: number): void;
  /** `frames` samples were lost (overflow); the timeline moves on by that much. */
  gap(frames: number): void;
  /** Audio stopped (device gone, settings changed). */
  stopped(): void;
}

export interface AudioHost {
  log(m: string): void;
  status(s: AudioStatus): void;
  /** Peak level per Dante channel, 0–1 (−60…0 dBFS), about 10 times a second. */
  levels(byChannel: Map<number, number>): void;
  /** Dante channel → has signal; called when one changes. */
  signal(byChannel: Map<number, boolean>): void;
}

interface Source {
  stop(): void;
}

// ---------------------------------------------------------------- the helper executable

const HELPER = process.platform === "win32" ? "stagemics-audio.exe" : "stagemics-audio";

/** SOUND_AUDIO_HELPER, next to the service executable (installed app), else the development builds. */
export function findHelper(): string | null {
  if (process.env.SOUND_AUDIO_HELPER) return existsSync(process.env.SOUND_AUDIO_HELPER) ? process.env.SOUND_AUDIO_HELPER : null;
  const here = dirname(fileURLToPath(import.meta.url));
  const list = [join(dirname(process.execPath), HELPER), join(here, HELPER)];
  const bins = join(here, "..", "..", "src-tauri", "binaries");
  try {
    for (const f of readdirSync(bins)) if (f.startsWith("stagemics-audio-")) list.push(join(bins, f));
  } catch {
    /* not a source checkout */
  }
  list.push(join(here, "..", "..", "native", "audio", "target", "release", HELPER));
  return list.find((p) => existsSync(p)) ?? null;
}

export function listDevices(): Promise<{ host: string; devices: AudioDevice[] }> {
  const helper = findHelper();
  if (!helper) return Promise.reject(new Error("The audio helper (stagemics-audio) is missing: run `pnpm build:audio`"));
  return new Promise((ok, fail) => {
    const p = spawn(helper, ["list"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => p.kill(), 8000);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => fail(e));
    p.on("close", (code) => {
      clearTimeout(timer);
      try {
        if (code !== 0) throw new Error(err.trim() || `the audio helper stopped (${code})`);
        ok(JSON.parse(out));
      } catch (e) {
        fail(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });
}

/** Reads the helper's packets (see native/audio/src/main.rs). */
function deviceSource(helper: string, device: string, rate: number, channels: number[], on: { info(rate: number, device: string): void; block(d: Float32Array[], n: number): void; gap(n: number): void; exit(err: string): void; log(m: string): void }): Source {
  const p: ChildProcess = spawn(helper, ["capture", "--device", device, "--rate", String(rate), "--channels", channels.join(",")], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let buf: Buffer = Buffer.alloc(0);
  let lastErr = "";
  let stopping = false;
  p.stdout!.on("data", (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    let at = 0;
    while (buf.length - at >= HEADER) {
      if (buf.readUInt32LE(at) !== MAGIC) {
        stopping = true;
        p.kill();
        on.exit("the audio helper sent something unexpected");
        return;
      }
      const kind = buf.readUInt32LE(at + 4);
      const a = buf.readUInt32LE(at + 8);
      const b = buf.readUInt32LE(at + 12);
      const len = kind === 1 ? a * b * 4 : kind === 3 ? a : 0;
      if (len > MAX_PACKET) {
        stopping = true;
        p.kill();
        on.exit("the audio helper sent something unexpected");
        return;
      }
      if (buf.length - at < HEADER + len) break;
      const body = at + HEADER;
      if (kind === 1) {
        // Interleaved f32 → one array per channel. Copy out first: the buffer is not 4-byte aligned.
        const raw = new Float32Array(buf.buffer.slice(buf.byteOffset + body, buf.byteOffset + body + len));
        const out = Array.from({ length: b }, () => new Float32Array(a));
        for (let f = 0; f < a; f++) for (let c = 0; c < b; c++) out[c][f] = raw[f * b + c];
        on.block(out, a);
      } else if (kind === 2) on.gap(a);
      else if (kind === 3) {
        try {
          const info = JSON.parse(buf.toString("utf8", body, body + len)) as { rate: number; device: string };
          on.info(info.rate, info.device);
        } catch {
          /* keep going */
        }
      }
      at = body + len;
    }
    buf = at ? buf.subarray(at) : buf;
  });
  p.stderr!.on("data", (d: Buffer) => {
    for (const line of String(d).split("\n").map((l) => l.trim()).filter(Boolean)) {
      if (!line.startsWith("capturing ")) lastErr = line;
      on.log(`audio: ${line}`);
    }
  });
  p.stdin!.on("error", () => {});
  p.on("error", (e) => {
    if (!stopping) on.exit(e.message);
    stopping = true;
  });
  p.on("close", (code, signal) => {
    if (!stopping) on.exit(lastErr || `the audio helper stopped (${signal ?? `exit ${code}`})`);
    stopping = true;
  });
  return {
    stop() {
      stopping = true;
      p.stdin!.end();
      setTimeout(() => p.kill(), 500).unref();
    },
  };
}

/**
 * A pretend Dante feed: each channel a tone that comes and goes like speech over a quiet floor (a pack that is
 * on), at 48 kHz in 10 ms blocks. Channels in `off` are digital silence (a pack that is off).
 */
function testSource(channels: number[], off: Set<number>, on: { info(rate: number, device: string): void; block(d: Float32Array[], n: number): void; gap(n: number): void }): Source {
  const t0 = performance.now();
  let made = 0;
  let seed = 12345;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x3fffffff - 1;
  };
  setImmediate(() => on.info(TEST_RATE, "Test signal"));
  const timer = setInterval(() => {
    const due = Math.floor(((performance.now() - t0) / 1000) * TEST_RATE);
    if (due - made > TEST_RATE * 2) {
      // The event loop stalled for seconds: say so, like a real overflow would.
      const lost = due - made - 480;
      on.gap(lost);
      made += lost;
    }
    while (due - made >= 480) {
      const n = 480;
      const data = channels.map((ch) => {
        const a = new Float32Array(n);
        if (off.has(ch)) return a;
        const f = 110 * (1 + ((ch - 1) % 8));
        for (let i = 0; i < n; i++) {
          const t = (made + i) / TEST_RATE;
          // Phrases of ~0.7 s with ~0.3 s pauses, shifted per channel.
          const phrase = Math.sin(2 * Math.PI * (t * 1.1 + ch * 0.13)) > -0.4 ? 0.25 : 0;
          a[i] = phrase * Math.sin(2 * Math.PI * f * t) + 0.003 * noise();
        }
        return a;
      });
      on.block(data, n);
      made += n;
    }
  }, 10);
  return { stop: () => clearInterval(timer) };
}

// ---------------------------------------------------------------- the input

export class AudioInput {
  private src: Source | null = null;
  private cfg: { s: AudioSettings; channels: number[] } | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private backoff = 1000;
  private lastBlock = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private meterTimer: ReturnType<typeof setInterval> | null = null;
  private peaks: Float32Array = new Float32Array(0);
  private lastSignalAt: number[] = [];
  private signal = new Map<number, boolean>();
  private nonZeroAt = 0;
  private running = false;
  /** Bumped on every (re)start: events from a source that was already replaced are ignored. */
  private gen = 0;
  /** Test signal: Dante channels that are "off". */
  testOff = new Set<number>();
  st: AudioStatus = { status: "off", source: "off", device: null, rate: null, channels: [], error: null, since: Date.now(), gaps: 0, silent: false };

  private host: AudioHost;
  private listener: AudioListener;

  constructor(host: AudioHost, listener: AudioListener) {
    this.host = host;
    this.listener = listener;
  }

  /** (Re)start from the settings and the Dante channels the show uses. Restarts only when something changed. */
  configure(s: AudioSettings, channels: number[], force = false) {
    const next = { s: { ...s }, channels: [...new Set(channels)].filter((c) => c >= 1).sort((x, y) => x - y) };
    if (!force && this.cfg && JSON.stringify(this.cfg) === JSON.stringify(next) && (this.src || this.retry)) return;
    this.cfg = next;
    this.backoff = 1000;
    this.restart();
  }

  get isRunning() {
    return this.running;
  }

  private set(patch: Partial<AudioStatus>) {
    const next = { ...this.st, ...patch };
    if (next.status !== this.st.status) next.since = Date.now();
    this.st = next;
    this.host.status(this.st);
  }

  private restart() {
    this.halt();
    const cfg = this.cfg!;
    const s = cfg.s;
    if (s.source === "off") return this.set({ status: "off", source: "off", device: null, rate: null, channels: [], error: null, silent: false });
    if (!cfg.channels.length) return this.set({ status: "error", source: s.source, error: "No mic has a Dante channel (Build → Dante)", channels: [] });
    this.set({ status: "starting", source: s.source, device: s.source === "test" ? "Test signal" : s.device, channels: cfg.channels, error: null, silent: false });
    const gen = this.gen;
    const handlers = {
      info: (rate: number, device: string) => {
        if (gen !== this.gen) return;
        this.running = true;
        this.backoff = 1000;
        this.lastBlock = Date.now();
        this.nonZeroAt = Date.now();
        this.peaks = new Float32Array(cfg.channels.length);
        this.lastSignalAt = cfg.channels.map(() => Date.now() - NO_SIGNAL_MS + 400);
        this.set({ status: "running", rate, device, error: null });
        this.host.log(`audio: ${device} running at ${rate} Hz, Dante channels ${cfg.channels.join(", ")}`);
        this.listener.run(rate, cfg.channels, s.source === "test" ? "test" : device);
      },
      block: (d: Float32Array[], n: number) => gen === this.gen && this.onBlock(d, n),
      gap: (n: number) => {
        if (!this.running || gen !== this.gen) return;
        this.set({ gaps: this.st.gaps + 1 });
        this.host.log(`audio: ${n} samples lost (the computer was too slow to read them)`);
        this.listener.gap(n);
      },
    };
    if (s.source === "test") {
      this.src = testSource(cfg.channels, this.testOff, handlers);
    } else {
      const helper = findHelper();
      if (!helper) return this.set({ status: "error", error: "The audio helper (stagemics-audio) is missing: run `pnpm build:audio`" });
      if (!s.device) return this.set({ status: "error", error: "Choose the Dante input device (Build → Dante)" });
      try {
        this.src = deviceSource(helper, s.device, s.rate, cfg.channels, {
          ...handlers,
          exit: (err) => gen === this.gen && this.failed(err),
          log: (m) => this.host.log(m),
        });
      } catch (e) {
        // spawn can throw (out of processes, a bad path): retry like any other failure instead of stopping for good.
        return this.failed(`cannot start the audio helper: ${e instanceof Error ? e.message : e}`);
      }
    }
    const startedAt = Date.now();
    this.watchdog = setInterval(() => {
      if (gen !== this.gen) return;
      if (this.running && Date.now() - this.lastBlock > WATCHDOG_MS) this.failed(`no audio from ${this.st.device} for ${WATCHDOG_MS / 1000} s`);
      else if (!this.running && Date.now() - startedAt > START_MS) this.failed(`${this.st.device} did not start within ${START_MS / 1000} s`);
    }, 500);
    this.meterTimer = setInterval(() => this.publish(), METER_MS);
  }

  private failed(err: string) {
    const wasRunning = this.running;
    this.halt();
    if (wasRunning) this.set({ gaps: this.st.gaps + 1 });
    // The same failure again (DVS not running yet…) is not logged every time.
    if (err !== this.st.error || wasRunning) this.host.log(`audio: ${err}; trying again in ${Math.round(this.backoff / 1000)} s`);
    this.set({ status: "error", error: err });
    this.retry = setTimeout(() => {
      this.retry = null;
      this.restart();
    }, this.backoff);
    this.backoff = Math.min(10000, this.backoff * 2);
  }

  private halt() {
    this.gen++;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.meterTimer) clearInterval(this.meterTimer);
    this.watchdog = this.meterTimer = null;
    this.src?.stop();
    this.src = null;
    if (this.running) {
      this.running = false;
      this.listener.stopped();
    }
    if (this.signal.size) {
      this.signal.clear();
      this.host.signal(this.signal);
    }
    this.host.levels(new Map());
  }

  private onBlock(d: Float32Array[], n: number) {
    if (!this.running) return;
    const now = Date.now();
    this.lastBlock = now;
    const cfg = this.cfg!;
    const floor = Math.pow(10, cfg.s.noSignalDb / 20);
    let any = false;
    for (let c = 0; c < d.length; c++) {
      const a = d[c];
      let peak = 0;
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const v = a[i] < 0 ? -a[i] : a[i];
        if (v > peak) peak = v;
        sum += a[i] * a[i];
      }
      if (peak > this.peaks[c]) this.peaks[c] = peak;
      if (peak > 0) any = true;
      if (Math.sqrt(sum / n) > floor) this.lastSignalAt[c] = now;
    }
    if (any) this.nonZeroAt = now;
    this.listener.block(d, n);
  }

  private publish() {
    if (!this.running) return;
    const cfg = this.cfg!;
    const now = Date.now();
    const levels = new Map<number, number>();
    let changed = false;
    cfg.channels.forEach((ch, c) => {
      const db = this.peaks[c] > 0 ? 20 * Math.log10(this.peaks[c]) : -120;
      levels.set(ch, Math.max(0, Math.min(1, (db + 60) / 60)));
      this.peaks[c] = 0;
      const has = now - this.lastSignalAt[c] < NO_SIGNAL_MS;
      if (this.signal.get(ch) !== has) {
        this.signal.set(ch, has);
        changed = true;
      }
    });
    const silent = now - this.nonZeroAt > SILENT_MS;
    if (silent !== this.st.silent) this.set({ silent });
    this.host.levels(levels);
    if (changed) this.host.signal(this.signal);
  }

  stop() {
    this.cfg = null;
    this.halt();
  }
}
