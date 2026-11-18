// The show recorder: one track per character for the whole show, silent wherever their mic was muted.
//
// While recording, every mic that is live (as the desk reports it) is written to a segment file: a mono
// 24-bit WAV that starts when the mic opens and ends when it is muted, the scene changes or the person on
// that mic changes. Muted mics write nothing. Each segment is filed under the character who wore that mic
// in the live scene (else "Mic n"), so when Mary changes packs between scenes her audio still lands on
// her track. Export ("reconcile") lays the segments of each track on the recording's timeline and fills
// the rest with silence: one file per person, as long as the recording, all starting together.
//
// Crash safety: segments are finished (sizes written, synced) when they close, and open ones get their
// sizes written every 2 s and synced every 6 s. session.json says what is where and is replaced atomically.
// After a crash the open segments are repaired from what is on disk. The app stopping while recording
// (crash, quit, power) does not end the recording: on the next start within 10 minutes it carries on on
// the same timeline, with silence for the time it was away. Only Stop ends a recording.
//
// Timeline: samples of the Dante feed since Record was pressed. Within one run of the audio input every
// track is sample-aligned; after the input restarts, the new run is placed by the wall clock.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { mkdir, open, readFile, rename, stat, statfs, writeFile, type FileHandle } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join, resolve, sep } from "node:path";
import { UserError } from "./errors.ts";
import { charById, effectiveMic, micLive, sceneById } from "./logic.ts";
import { uid, type MeterFrame, type RecExport, type RecMarker, type RecSegment, type RecSession, type RecStatus, type RecTrackInfo, type Runtime, type Settings, type SoundScene, type SoundShow } from "./model.ts";
import { BYTES, encode24, fitsInWav, mix24, patchSizes, readWavInfo, repairWav, wavHeader, type WavMeta } from "./wav.ts";

export interface RecHost {
  show(): SoundShow;
  rt(): Runtime;
  settings(): Settings;
  log(m: string): void;
  /** rt.rec changed. */
  changed(): void;
}

export const DEFAULT_REC_FOLDER = join(homedir(), "StageMics Recordings");
const SESSION_FILE = "session.json";
const RESUME_WITHIN_MS = 10 * 60 * 1000;
const RING_SECONDS = 2.5;
const FLUSH_MS = 250;
const CHECKPOINT_MS = 2000;
const SYNC_EVERY = 3; // checkpoints
const DISK_MS = 10000;
const LOW_DISK = 4 * 1024 ** 3;
const SLOW_DISK = 32 * 1024 ** 2;
const FADE_S = 0.01;

const safeName = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 80) || "Untitled";
const pad = (n: number, w = 2) => String(n).padStart(w, "0");
export const fmtDur = (sec: number) => `${Math.floor(sec / 3600)}:${pad(Math.floor((sec % 3600) / 60))}:${pad(Math.floor(sec % 60))}`;
const fmtTc = (sec: number) => {
  const ms = Math.round(sec * 1000);
  return `${fmtDur(Math.floor(ms / 1000))}.${pad(ms % 1000, 3)}`;
};

type SessionSummary = ReturnType<typeof summarise>;

function summarise(s: RecSession, folder: string) {
  const rate = s.rate || 48000;
  return {
    id: s.id, name: s.name, state: s.state, startedAt: s.startedAt, seconds: Math.round(s.length / rate), folder,
    tracks: Object.values(s.tracks).map((t) => t.name), segments: s.segments.length,
    scenes: s.scenes.map((r) => ({ scene: r.scene, code: r.code, name: r.name, start: Math.round(r.start / rate), end: r.end === null ? null : Math.round(r.end / rate) })),
    bytes: s.segments.reduce((a, x) => a + x.length * BYTES, 0),
  };
}

async function writeJsonAtomic(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 1));
  await rename(tmp, file);
}

// ---------------------------------------------------------------- one segment file

/** A growing mono 24-bit WAV. Appends are buffered and written in order off the main thread. */
class SegmentFile {
  private fh: FileHandle | null = null;
  private queue: Promise<void>;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private queuedFrames = 0;
  private checkpoints = 0;
  readonly dataOffset: number;
  /** Samples handed in. */
  frames = 0;
  /** Samples safely on disk. */
  flushed = 0;
  error: Error | null = null;
  readonly path: string;
  private onError: (e: Error) => void;
  private onWrite: (bytes: number) => void;

  constructor(path: string, meta: WavMeta, onError: (e: Error) => void, onWrite: (bytes: number) => void) {
    this.path = path;
    this.onError = onError;
    this.onWrite = onWrite;
    const { header, dataOffset } = wavHeader(meta, 0);
    this.dataOffset = dataOffset;
    this.queue = (async () => {
      this.fh = await open(path, "wx");
      await this.fh.write(header, 0, header.length, 0);
    })().catch((e) => this.fail(e));
  }

  private fail(e: unknown) {
    if (this.error) return;
    this.error = e instanceof Error ? e : new Error(String(e));
    this.onError(this.error);
  }

  append(src: Float32Array, from: number, to: number) {
    if (to <= from || this.error) return;
    const b = Buffer.allocUnsafe((to - from) * BYTES);
    encode24(src, from, to, b);
    this.push(b, to - from);
  }

  silence(n: number) {
    if (n > 0 && !this.error) this.push(Buffer.alloc(n * BYTES), n);
  }

  private push(b: Buffer, n: number) {
    this.pending.push(b);
    this.pendingBytes += b.length;
    this.frames += n;
    if (this.pendingBytes >= 192 * 1024) this.flush();
  }

  flush() {
    if (!this.pending.length || this.error) return;
    const chunk = this.pending.length === 1 ? this.pending[0] : Buffer.concat(this.pending);
    const n = chunk.length / BYTES;
    const at = this.dataOffset + this.queuedFrames * BYTES;
    this.pending = [];
    this.pendingBytes = 0;
    this.queuedFrames += n;
    this.queue = this.queue
      .then(async () => {
        if (this.error || !this.fh) return;
        await this.fh.write(chunk, 0, chunk.length, at);
        this.flushed += n;
        this.onWrite(chunk.length);
      })
      .catch((e) => this.fail(e));
  }

  /** Write the sizes so the file plays as it is (and now and then make sure it is on the disk). */
  checkpoint() {
    this.flush();
    const sync = ++this.checkpoints % SYNC_EVERY === 0;
    this.queue = this.queue
      .then(async () => {
        if (this.error || !this.fh) return;
        await patchSizes(this.fh, this.dataOffset, this.flushed);
        if (sync) await this.fh.datasync();
      })
      .catch((e) => this.fail(e));
  }

  /** Not yet on disk (bytes). */
  get backlog() {
    return (this.queuedFrames - this.flushed) * BYTES + this.pendingBytes;
  }

  async close() {
    this.flush();
    this.queue = this.queue
      .then(async () => {
        if (!this.fh) return;
        if (!this.error) {
          await patchSizes(this.fh, this.dataOffset, this.flushed);
          await this.fh.datasync();
        }
        await this.fh.close();
        this.fh = null;
      })
      .catch((e) => this.fail(e));
    await this.queue;
  }
}

interface OpenSeg {
  key: string;
  meta: RecSegment;
  file: SegmentFile;
  /** Index into the audio blocks. */
  ch: number;
  /** Where it stops (mute + post-roll); null while live. */
  endAt: number | null;
}

interface Want {
  track: string;
  info: RecTrackInfo;
  mic: number | null;
  dante: number;
  ch: number;
}

// ---------------------------------------------------------------- the recorder

export class Recorder {
  st: RecStatus;
  private session: RecSession | null = null;
  private dir = "";
  private segs = new Map<string, OpenSeg>();
  private lastEnd = new Map<string, number>();
  private closing = new Set<Promise<void>>();
  private audio: { rate: number; channels: number[]; source: string } | null = null;
  private chIndex = new Map<number, number>();
  private inRun = false;
  private pos = 0;
  private ring: Float32Array[] = [];
  private ringStart = 0;
  private curScene: string | null = null;
  private curCue = "";
  private bytes = 0;
  private lastWriteAt: number | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveChain: Promise<void> = Promise.resolve();
  private lastStatus = "";
  private failing = false;
  private host: RecHost;

  constructor(host: RecHost) {
    this.host = host;
    this.st = { state: "idle", session: null, open: [], rev: 0, segments: 0, error: null, warnings: [], resumed: null, disk: null, exports: [], folder: this.folder() };
  }

  folder() {
    return resolve(this.host.settings().recorder.folder || DEFAULT_REC_FOLDER);
  }

  get recording() {
    return !!this.session;
  }

  // ---------------------------------------------------------------- start, stop, recover

  /** Close recordings a crash left open; carry on with the newest if the app was away for less than 10 minutes. */
  async init() {
    let dirs: string[] = [];
    try {
      dirs = readdirSync(this.folder());
    } catch {
      return;
    }
    let newest: { dir: string; s: RecSession } | null = null;
    for (const d of dirs) {
      const dir = join(this.folder(), d);
      const s = await this.readSession(dir);
      if (!s || s.state !== "recording") continue;
      try {
        await this.repair(dir, s);
        this.host.log(`recorder: “${s.name}” was still recording when the app stopped; its files are closed (${fmtDur(s.length / (s.rate || 48000))})`);
        if (!newest || s.updatedAt > newest.s.updatedAt) newest = { dir, s };
      } catch (e) {
        this.host.log(`recorder: could not repair ${dir}: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (newest && Date.now() - newest.s.updatedAt < RESUME_WITHIN_MS && this.host.settings().audio.source !== "off") this.resume(newest.dir, newest.s);
    this.status();
  }

  private async readSession(dir: string): Promise<RecSession | null> {
    try {
      const s = JSON.parse(await readFile(join(dir, SESSION_FILE), "utf8")) as RecSession;
      return s && typeof s === "object" && Array.isArray(s.segments) ? s : null;
    } catch {
      return null;
    }
  }

  private async repair(dir: string, s: RecSession) {
    for (const seg of s.segments) {
      if (!seg.open) continue;
      const path = join(dir, "segments", seg.file);
      seg.length = existsSync(path) ? (await repairWav(path)).frames : 0;
      seg.open = false;
      seg.recovered = true;
    }
    const end = Math.max(s.length, ...s.segments.map((x) => x.start + x.length));
    s.length = end;
    for (const r of s.scenes) if (r.end === null) r.end = end;
    s.state = "interrupted";
    await writeJsonAtomic(join(dir, SESSION_FILE), s);
  }

  private resume(dir: string, s: RecSession) {
    s.state = "recording";
    s.stoppedAt = null;
    this.session = s;
    this.dir = dir;
    for (const seg of s.segments) this.lastEnd.set(seg.mic != null ? `m:${seg.mic}` : `t:${seg.track.slice(4)}`, seg.start + seg.length);
    this.curScene = null;
    this.st.resumed = { at: Date.now(), lostSeconds: 0 };
    this.host.log(`recorder: carrying on with “${s.name}” after the restart`);
    this.startTimers();
    if (this.audio) this.place();
    void this.save();
  }

  start(name?: string) {
    if (this.session) throw new UserError("Already recording");
    const settings = this.host.settings();
    if (settings.audio.source === "off") throw new UserError("Turn on the Dante input first (Build → Dante)");
    const show = this.host.show();
    const now = new Date();
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())}`;
    let id = safeName(`${stamp} ${name || show.name}`);
    for (let k = 2; existsSync(join(this.folder(), id)); k++) id = safeName(`${stamp} ${name || show.name} (${k})`);
    const dir = join(this.folder(), id);
    try {
      mkdirSync(join(dir, "segments"), { recursive: true });
    } catch (e) {
      throw new UserError(`Cannot make the recording folder ${dir}: ${e instanceof Error ? e.message : e}`);
    }
    this.session = {
      version: 1, id, name: name || `${show.name} · ${now.toLocaleDateString()} ${now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
      showId: show.showId, showName: show.name, startedAt: now.getTime(), stoppedAt: null, updatedAt: now.getTime(), state: "recording",
      rate: this.audio?.rate ?? 0, length: 0, runs: [], tracks: {}, segments: [], scenes: [], markers: [], nextSegment: 1,
      preRollMs: settings.recorder.preRollMs, postRollMs: settings.recorder.postRollMs,
    };
    this.dir = dir;
    this.lastEnd.clear();
    this.curScene = null;
    this.curCue = "";
    this.bytes = 0;
    this.lastWriteAt = null;
    this.st.error = null;
    this.st.resumed = null;
    this.failing = false;
    if (this.audio) this.beginRun(0);
    this.startTimers();
    this.host.log(`recorder: recording “${this.session.name}” to ${dir}`);
    this.sync();
    void this.save();
    void this.checkDisk();
    return { id, folder: dir, audio: this.inRun };
  }

  /** Stop (the operator) or leave (the app is stopping: the recording carries on after the restart). */
  async stop(why: "stopped" | "interrupted" = "stopped") {
    const s = this.session;
    if (!s) return { stopped: null };
    const dir = this.dir;
    for (const seg of [...this.segs.values()]) this.closeSeg(seg);
    const last = s.scenes.at(-1);
    if (last && last.end === null) last.end = this.pos;
    if (this.inRun) s.length = Math.max(s.length, this.pos);
    s.state = why;
    s.stoppedAt = Date.now();
    s.updatedAt = Date.now();
    this.session = null;
    this.inRun = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await Promise.allSettled([...this.closing]);
    await this.save(dir, s);
    const sec = s.rate ? s.length / s.rate : 0;
    this.host.log(`recorder: ${why === "stopped" ? "stopped" : "left for the restart"} “${s.name}” · ${fmtDur(sec)} · ${s.segments.length} segments`);
    this.status();
    return { stopped: s.id, folder: dir, seconds: Math.round(sec), tracks: Object.keys(s.tracks).length, segments: s.segments.length };
  }

  mark(label: string) {
    const s = this.session;
    if (!s || !this.inRun) throw new UserError("Not recording");
    const m: RecMarker = { at: this.pos, kind: "mark", label: label.slice(0, 120) || "Mark" };
    s.markers.push(m);
    this.bump();
    return { at: Math.round((m.at / s.rate) * 10) / 10 };
  }

  /** Where the recording is now (for markers sent to other apps), or null while not writing. */
  where(): { id: string; name: string; sample: number; rate: number } | null {
    const s = this.session;
    if (!s || !this.inRun || !s.rate) return null;
    return { id: s.id, name: s.name, sample: this.pos, rate: s.rate };
  }

  // ---------------------------------------------------------------- audio in

  /** The audio input (re)started. */
  run(rate: number, channels: number[], source: string) {
    this.audio = { rate, channels, source };
    this.chIndex = new Map(channels.map((c, i) => [c, i]));
    if (this.session) this.place();
  }

  /** Put a new run of audio on the timeline: right away for a fresh recording, else where the wall clock says. */
  private place() {
    const s = this.session!;
    const a = this.audio!;
    if (s.rate && s.rate !== a.rate) return this.fail(`the Dante input changed from ${s.rate} to ${a.rate} Hz`);
    s.rate = a.rate;
    const wall = Math.round(((Date.now() - s.startedAt) / 1000) * a.rate);
    const offset = s.runs.length || wall > a.rate / 2 ? Math.max(s.length, wall) : 0;
    if (offset > s.length) {
      const lost = (offset - s.length) / a.rate;
      s.markers.push({ at: s.length, kind: "gap", label: `No audio for ${lost.toFixed(1)} s` });
      if (this.st.resumed) this.st.resumed.lostSeconds = Math.round(lost * 10) / 10;
    }
    this.beginRun(offset);
    this.sync();
  }

  private beginRun(offset: number) {
    const s = this.session!;
    const a = this.audio!;
    s.rate = a.rate;
    this.inRun = true;
    this.pos = offset;
    s.length = offset;
    const cap = Math.ceil(a.rate * RING_SECONDS);
    this.ring = a.channels.map(() => new Float32Array(cap));
    this.ringStart = offset;
    s.runs.push({ offset, at: Date.now(), source: a.source });
    this.bump();
  }

  stopped() {
    this.audio = null;
    if (!this.session || !this.inRun) return;
    for (const seg of [...this.segs.values()]) this.closeSeg(seg);
    this.inRun = false;
    this.session.length = this.pos;
    this.host.log("recorder: the audio stopped; the recording carries on when it is back");
    this.bump();
  }

  block(data: Float32Array[], frames: number) {
    if (this.session && this.inRun) this.advance(data, frames);
  }

  gap(frames: number) {
    const s = this.session;
    if (!s || !this.inRun) return;
    s.markers.push({ at: this.pos, kind: "gap", label: `${frames} samples lost` });
    this.advance(null, frames);
    this.bump();
  }

  private advance(data: Float32Array[] | null, frames: number) {
    const p0 = this.pos;
    const p1 = p0 + frames;
    const cap = this.ring[0]?.length ?? 0;
    if (cap) {
      for (let c = 0; c < this.ring.length; c++) {
        const r = this.ring[c];
        const d = data?.[c];
        for (let i = 0; i < frames; i++) r[(p0 + i) % cap] = d ? d[i] : 0;
      }
      this.ringStart = Math.max(this.ringStart, p1 - cap);
    }
    for (const seg of [...this.segs.values()]) {
      const from = seg.meta.start + seg.file.frames;
      const to = seg.endAt === null ? p1 : Math.min(seg.endAt, p1);
      if (to > from) {
        if (data) seg.file.append(data[seg.ch], from - p0, to - p0);
        else seg.file.silence(to - from);
      }
      if (seg.endAt !== null && seg.endAt <= p1) this.closeSeg(seg);
    }
    this.pos = p1;
    this.session!.length = p1;
  }

  // ---------------------------------------------------------------- who is written where

  /** Follow the show: called after every change (mutes from anywhere, cues, scenes, backstage swaps). */
  sync() {
    const s = this.session;
    if (!s || !this.inRun) return this.status();
    const show = this.host.show();
    const rt = this.host.rt();
    const sc = sceneById(show, rt.activeSceneId);
    const sceneId = sc?.id ?? null;
    const sceneChanged = sceneId !== this.curScene;
    if (sceneChanged) {
      const last = s.scenes.at(-1);
      if (last && last.end === null) last.end = this.pos;
      if (sc) s.scenes.push({ scene: sc.id, code: sc.code, name: sc.name, start: this.pos, end: null });
      this.curScene = sceneId;
      this.bump();
    }
    const cueKey = `${sceneId}:${rt.cue}`;
    if (cueKey !== this.curCue) {
      this.curCue = cueKey;
      const q = sc?.cues[rt.cue];
      if (sc && q) {
        s.markers.push({ at: this.pos, kind: "cue", label: `${sc.code} Q${rt.cue + 1} ${q.label}` });
        this.bump();
      }
    }
    const seen = new Set<string>();
    for (const m of show.mics) {
      const key = `m:${m.n}`;
      seen.add(key);
      const ch = m.dante != null ? this.chIndex.get(m.dante) : undefined;
      const live = micLive(show, rt, m.n) === true;
      this.gate(key, live && ch !== undefined ? this.micWant(show, sc, m.n, m.dante!, ch) : null, sceneChanged);
    }
    for (const t of show.recTracks) {
      const key = `t:${t.id}`;
      seen.add(key);
      const ch = this.chIndex.get(t.dante);
      this.gate(key, ch !== undefined ? { track: `rec:${t.id}`, info: { id: `rec:${t.id}`, kind: "always", name: t.name }, mic: null, dante: t.dante, ch } : null, sceneChanged);
    }
    for (const seg of [...this.segs.values()]) if (!seen.has(seg.key)) this.closeSeg(seg);
    this.status();
  }

  /** The character wearing mic n in the live scene, else the mic itself. */
  private micWant(show: SoundShow, sc: SoundScene | null, n: number, dante: number, ch: number): Want {
    const holder = sc?.cast.find((id) => effectiveMic(show, sc, id) === n);
    const c = holder ? charById(show, holder) : null;
    const info: RecTrackInfo = c ? { id: `char:${c.id}`, kind: "character", name: c.name, charId: c.id } : { id: `mic:${n}`, kind: "mic", name: `Mic ${n}`, mic: n };
    return { track: info.id, info, mic: n, dante, ch };
  }

  private gate(key: string, want: Want | null, sceneChanged: boolean) {
    const s = this.session!;
    const cur = this.segs.get(key);
    if (!want) {
      // Muted: keep writing for the post-roll, then close.
      if (cur && cur.endAt === null) cur.endAt = this.pos + Math.round((s.postRollMs / 1000) * s.rate);
      return;
    }
    if (cur && cur.meta.track === want.track && cur.ch === want.ch && !sceneChanged) {
      cur.endAt = null; // opened again within the post-roll: the same segment goes on
      return;
    }
    let start: number;
    if (cur) {
      // Same mic, someone else or a new scene: the old segment ends here and the new one starts here, seamless.
      this.closeSeg(cur);
      start = this.pos;
    } else {
      start = Math.max(this.pos - Math.round((s.preRollMs / 1000) * s.rate), this.ringStart, this.lastEnd.get(key) ?? 0);
    }
    this.openSeg(key, want, start);
  }

  private openSeg(key: string, want: Want, start: number) {
    const s = this.session!;
    const show = this.host.show();
    s.tracks[want.track] = want.info;
    let id: number;
    let file: string;
    // A crash just after a segment was created and before session.json said so leaves its file: never reuse the name.
    do {
      id = s.nextSegment++;
      file = safeName(`${pad(id, 4)} ${want.info.name}${want.mic != null && want.info.kind === "character" ? ` (mic ${want.mic})` : ""}`) + ".wav";
    } while (existsSync(join(this.dir, "segments", file)));
    const meta: RecSegment = { id, file, track: want.track, mic: want.mic, dante: want.dante, start, length: 0, open: true, scene: this.curScene };
    const w = new SegmentFile(
      join(this.dir, "segments", file),
      { rate: s.rate, startedAt: s.startedAt + (start / s.rate) * 1000, description: `${want.info.name} · ${show.name} · segment ${id}` },
      (e) => this.fail(`cannot write ${file}: ${e.message}`),
      (bytes) => {
        this.bytes += bytes;
        this.lastWriteAt = Date.now();
      },
    );
    const seg: OpenSeg = { key, meta, file: w, ch: want.ch, endAt: null };
    // Pre-roll: what the mic picked up just before it opened, from the ring.
    if (start < this.pos && this.ring.length) {
      const cap = this.ring[0].length;
      const r = this.ring[want.ch];
      const tmp = new Float32Array(this.pos - start);
      for (let p = start; p < this.pos; p++) tmp[p - start] = r[p % cap];
      w.append(tmp, 0, tmp.length);
    }
    s.segments.push(meta);
    this.segs.set(key, seg);
    this.st.rev++;
    void this.save();
  }

  private closeSeg(seg: OpenSeg) {
    this.segs.delete(seg.key);
    seg.meta.length = seg.file.frames;
    seg.meta.open = false;
    this.lastEnd.set(seg.key, seg.meta.start + seg.meta.length);
    const p = seg.file
      .close()
      .then(() => {
        seg.meta.length = seg.file.flushed;
      })
      .finally(() => {
        this.closing.delete(p);
        if (this.session) void this.save();
      });
    this.closing.add(p);
    this.bump();
  }

  private fail(msg: string) {
    if (this.failing) return;
    this.failing = true;
    this.host.log(`recorder: ${msg}: recording stopped`);
    this.st.error = msg;
    void this.stop("interrupted").then(() => {
      this.failing = false;
      this.st.error = msg;
      this.status();
    });
  }

  // ---------------------------------------------------------------- bookkeeping

  private startTimers() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [
      setInterval(() => {
        for (const seg of this.segs.values()) seg.file.flush();
      }, FLUSH_MS),
      setInterval(() => {
        const s = this.session;
        if (!s) return;
        for (const seg of this.segs.values()) {
          seg.file.checkpoint();
          seg.meta.length = seg.file.flushed;
        }
        s.updatedAt = Date.now();
        void this.save();
        this.status();
      }, CHECKPOINT_MS),
      setInterval(() => void this.checkDisk(), DISK_MS),
    ];
  }

  private async checkDisk() {
    try {
      const f = await statfs(this.session ? this.dir : this.folder());
      this.st.disk = { free: f.bavail * f.bsize, total: f.blocks * f.bsize };
    } catch {
      this.st.disk = null;
    }
    this.status();
  }

  private bump() {
    this.st.rev++;
    this.saveSoon();
  }

  private saveSoon() {
    if (this.saveTimer || !this.session) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, 300);
  }

  /**
   * Write session.json, in order. A write that is queued but not started yet already covers any later
   * change (it serialises the session when it runs), so asking again then only waits for it: a cue that
   * closes and opens ten segments costs one or two writes of a file that grows all show, not twenty.
   */
  private save(dir = this.dir, s = this.session): Promise<void> {
    if (!s || !dir) return this.saveChain;
    const q = this.queuedSave;
    if (q && q.dir === dir && q.s === s) return this.saveChain;
    const job = { dir, s };
    this.queuedSave = job;
    this.saveChain = this.saveChain
      .then(() => {
        if (this.queuedSave === job) this.queuedSave = null;
        return writeJsonAtomic(join(dir, SESSION_FILE), s);
      })
      .catch((e) => this.host.log(`recorder: could not save ${SESSION_FILE}: ${e instanceof Error ? e.message : e}`));
    return this.saveChain;
  }
  private queuedSave: { dir: string; s: RecSession } | null = null;

  /** rt.rec from the current state; tells the engine only when something a screen shows changed. */
  private status() {
    const s = this.session;
    const show = this.host.show();
    const st = this.st;
    st.state = s ? "recording" : "idle";
    st.folder = this.folder();
    if (s) st.session = { id: s.id, name: s.name, folder: this.dir, startedAt: s.startedAt, rate: s.rate };
    st.segments = s?.segments.length ?? st.segments;
    st.open = [...this.segs.values()].map((x) => ({ key: x.key, track: x.meta.track, name: s?.tracks[x.meta.track]?.name ?? x.meta.track, mic: x.meta.mic, since: x.meta.start }));
    const w: string[] = [];
    if (s) {
      if (!this.inRun) w.push("No audio is coming in from Dante: the recording goes on as soon as it is back");
      const backlog = [...this.segs.values()].reduce((a, x) => a + x.file.backlog, 0);
      if (backlog > SLOW_DISK) w.push(`The recording disk is falling behind (${Math.round(backlog / 1024 ** 2)} MB waiting)`);
      if (this.segs.size && this.lastWriteAt && Date.now() - this.lastWriteAt > 3000) w.push(`Nothing written for ${Math.round((Date.now() - this.lastWriteAt) / 1000)} s`);
      const off = show.mics.filter((m) => m.dante == null).map((m) => m.n);
      if (off.length) w.push(`${off.length === 1 ? `Mic ${off[0]} has` : `Mics ${off.join(", ")} have`} no Dante channel: not recorded`);
      if (st.disk && st.disk.free < LOW_DISK) {
        const perHour = (s.rate || 48000) * BYTES * 3600 * Math.max(1, show.mics.length);
        w.push(`Only ${(st.disk.free / 1024 ** 3).toFixed(1)} GB free on the recording disk (about ${Math.max(0, Math.floor((st.disk.free / perHour) * 60))} min with every mic live)`);
      }
    }
    st.warnings = w;
    const key = JSON.stringify({ ...st, disk: st.disk ? Math.round(st.disk.free / 1e8) : null, exports: st.exports.map((e) => [e.id, e.state, Math.round(e.progress * 50)]) });
    if (key !== this.lastStatus) {
      this.lastStatus = key;
      this.host.changed();
    }
  }

  /** For the meters message: is it really writing? */
  pulse(): MeterFrame["rec"] {
    const s = this.session;
    return s ? { pos: this.inRun ? this.pos : s.length, rate: s.rate, bytes: this.bytes, writeAgo: this.lastWriteAt ? Date.now() - this.lastWriteAt : null } : null;
  }

  // ---------------------------------------------------------------- recordings on disk

  async sessions() {
    let dirs: string[] = [];
    try {
      dirs = readdirSync(this.folder());
    } catch {
      return [];
    }
    const out: SessionSummary[] = [];
    const keep = new Map<string, { key: string; sum: SessionSummary | null }>();
    for (const d of dirs) {
      const folder = join(this.folder(), d);
      if (d === this.session?.id) {
        out.push(summarise(this.liveCopy(), folder));
        continue;
      }
      // Finished recordings do not change: read each session.json again only when the file did.
      let key = "";
      try {
        const st = await stat(join(folder, SESSION_FILE));
        key = `${st.size}:${st.mtimeMs}`;
      } catch {
        continue;
      }
      const hit = this.summaries.get(folder);
      const sum = hit && hit.key === key ? hit.sum : await this.readSession(folder).then((s) => (s ? summarise(s, folder) : null));
      keep.set(folder, { key, sum });
      if (sum) out.push(sum);
    }
    this.summaries = keep;
    return out.sort((a, b) => b.startedAt - a.startedAt);
  }
  private summaries = new Map<string, { key: string; sum: SessionSummary | null }>();

  /** The whole session.json (with live lengths while recording), for the Recorder tab's timeline. */
  async sessionInfo(id: string | null) {
    const ref = id || this.session?.id || this.st.session?.id;
    if (!ref) throw new UserError("No recording yet");
    const s = ref === this.session?.id ? this.liveCopy() : await this.readSession(this.sessionDir(ref));
    if (!s) throw new UserError(`No recording “${ref}”`);
    return s;
  }

  private liveCopy(): RecSession {
    const s = structuredClone(this.session!);
    const open = new Map([...this.segs.values()].map((x) => [x.meta.id, x.file.flushed]));
    if (open.size) for (const seg of s.segments) if (open.has(seg.id)) seg.length = open.get(seg.id)!;
    return s;
  }

  private sessionDir(id: string) {
    const dir = resolve(this.folder(), id);
    if (!dir.startsWith(this.folder() + sep) || !existsSync(join(dir, SESSION_FILE))) throw new UserError(`No recording “${id}”`);
    return dir;
  }

  /** Open a recording's folder (or its export) in Finder / Explorer on this computer. */
  reveal(id: string | null, sub?: string) {
    const ref = id || this.st.session?.id;
    const base = ref ? this.sessionDir(ref) : this.folder();
    const target = sub ? resolve(base, sub) : base;
    if (target !== base && !target.startsWith(base + sep)) throw new UserError("Not inside that recording");
    if (!existsSync(target)) {
      if (target !== this.folder()) throw new UserError(`${target} is not there any more`);
      mkdirSync(target, { recursive: true });
    }
    const cmd = platform() === "darwin" ? "open" : platform() === "win32" ? "explorer" : "xdg-open";
    const child = spawn(cmd, [target], { detached: true, stdio: "ignore" });
    child.on("error", (e) => this.host.log(`recorder: cannot open ${target}: ${e.message}`));
    child.unref();
    return { folder: target };
  }

  // ---------------------------------------------------------------- export (reconcile)

  /**
   * One file per person for a range of the timeline: the whole recording ("show"), every scene ("scenes"), or
   * the runs of one scene. `by: "mic"` makes one file per mic instead. Runs in the background; progress in rt.rec.exports.
   */
  async export(opts: { session?: string | null; scope: string; by?: "character" | "mic" }) {
    const s = await this.sessionInfo(opts.session ?? null);
    if (!s.rate || !s.length) throw new UserError("That recording has no audio yet");
    const dir = s.id === this.session?.id ? this.dir : this.sessionDir(s.id);
    const by = opts.by === "mic" ? "mic" : "character";
    // `scene`: only that scene's segments (they are split where scenes change, so another scene's in this range is just its post-roll tail).
    type Range = { label: string; start: number; end: number; scene: string | null };
    let ranges: Range[];
    const runLabel = (r: RecSession["scenes"][number], k: number, of: number) => `Scene ${r.code} - ${r.name}${of > 1 ? ` (take ${k + 1})` : ""}`;
    if (opts.scope === "show") ranges = [{ label: by === "mic" ? "Full show (by mic)" : "Full show", start: 0, end: s.length, scene: null }];
    else {
      const runs = opts.scope === "scenes" ? s.scenes : s.scenes.filter((r) => r.scene === opts.scope || r.code === opts.scope);
      if (!runs.length) throw new UserError(opts.scope === "scenes" ? "No scene was live during that recording" : `Scene ${opts.scope} was not live during that recording`);
      const count = new Map<string, number>();
      for (const r of runs) count.set(r.scene, (count.get(r.scene) ?? 0) + 1);
      const seen = new Map<string, number>();
      ranges = runs.map((r) => {
        const k = seen.get(r.scene) ?? 0;
        seen.set(r.scene, k + 1);
        return { label: runLabel(r, k, count.get(r.scene)!), start: r.start, end: r.end ?? s.length, scene: r.scene };
      });
    }
    for (const r of ranges) if (!fitsInWav(r.end - r.start)) throw new UserError(`${r.label} is longer than a WAV file can hold (about 8 hours): export scenes instead`);
    const job: RecExport = { id: uid("exp"), session: s.id, label: ranges.length === 1 ? ranges[0].label : opts.scope === "scenes" ? "Every scene" : ranges[0].label.replace(/ \(take 1\)$/, ""), state: "running", progress: 0, folder: join(dir, "Export"), sub: "Export", files: 0, error: null, at: Date.now() };
    this.st.exports = [job, ...this.st.exports.filter((e) => e.state === "running" || Date.now() - e.at < 3600_000)].slice(0, 8);
    this.status();
    void this.runExport(job, s, dir, ranges, by).catch((e) => {
      job.state = "error";
      job.error = e instanceof Error ? e.message : String(e);
      this.host.log(`recorder: export “${job.label}” failed: ${job.error}`);
      this.status();
    });
    return { id: job.id, folder: job.folder, ranges: ranges.map((r) => r.label) };
  }

  private async runExport(job: RecExport, s: RecSession, dir: string, ranges: { label: string; start: number; end: number; scene: string | null }[], by: "character" | "mic") {
    const show = this.host.show();
    const plans = ranges.map((r) => {
      const groups = new Map<string, { name: string; order: number; segs: RecSegment[] }>();
      for (const seg of s.segments) {
        if (seg.length <= 0 || seg.start >= r.end || seg.start + seg.length <= r.start || (r.scene && seg.scene !== r.scene)) continue;
        const t = s.tracks[seg.track];
        const key = by === "mic" && seg.mic != null ? `mic:${seg.mic}` : seg.track;
        if (!groups.has(key)) {
          const order =
            key.startsWith("char:") ? Math.max(0, show.characters.findIndex((c) => c.id === key.slice(5))) :
            key.startsWith("mic:") ? 1000 + Number(key.slice(4)) : 2000;
          groups.set(key, { name: key.startsWith("mic:") ? `Mic ${key.slice(4)}` : t?.name ?? key, order, segs: [] });
        }
        groups.get(key)!.segs.push(seg);
      }
      return { r, groups: [...groups.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)) };
    });
    const total = plans.reduce((a, p) => a + p.groups.length * (p.r.end - p.r.start), 0) || 1;
    let done = 0;
    let lastTick = 0;
    const tick = (n: number) => {
      done += n;
      job.progress = Math.min(0.999, done / total);
      if (Date.now() - lastTick > 300) {
        lastTick = Date.now();
        this.status();
      }
    };
    for (const { r, groups } of plans) {
      const out = join(dir, "Export", safeName(r.label));
      await mkdir(out, { recursive: true });
      const used = new Set<string>();
      let k = 0;
      for (const g of groups) {
        let name = `${pad(++k)} ${safeName(g.name)}`;
        while (used.has(name)) name += "_";
        used.add(name);
        await this.writeTrack(join(out, `${name}.wav`), g.segs, r, s, dir, g.name, tick);
        job.files++;
      }
      await writeFile(join(out, "markers.csv"), this.markersCsv(s, r));
      await writeFile(join(out, "About these files.txt"), this.aboutText(s, r, groups.map((g) => g.name), by));
    }
    job.state = "done";
    job.progress = 1;
    job.at = Date.now();
    job.sub = plans.length === 1 ? join("Export", safeName(plans[0].r.label)) : "Export";
    job.folder = join(dir, job.sub);
    this.host.log(`recorder: exported “${job.label}”: ${job.files} files in ${job.folder}`);
    this.status();
  }

  private async writeTrack(path: string, segs: RecSegment[], r: { label: string; start: number; end: number }, s: RecSession, dir: string, name: string, tick: (n: number) => void) {
    const rate = s.rate;
    const frames = r.end - r.start;
    const { header } = wavHeader({ rate, startedAt: s.startedAt + (r.start / rate) * 1000, description: `${name} · ${s.showName} · ${r.label}` }, frames);
    const fade = Math.max(1, Math.round(rate * FADE_S));
    // A fade only where the track goes from silence to sound (not where one segment carries straight on in the next).
    const edges = segs.map((seg) => ({
      seg,
      fin: !segs.some((o) => o !== seg && o.start + o.length === seg.start),
      fout: !segs.some((o) => o !== seg && o.start === seg.start + seg.length),
    }));
    const handles = new Map<string, { fh: FileHandle; dataOffset: number }>();
    const tmp = `${path}.part`;
    const fh = await open(tmp, "w");
    try {
      await fh.write(header, 0, header.length, 0);
      let at = header.length;
      const chunk = rate;
      const mixBuf = new Float32Array(chunk);
      const outBuf = Buffer.alloc(chunk * BYTES);
      const zero = Buffer.alloc(chunk * BYTES);
      for (let p = r.start; p < r.end; p += chunk) {
        const n = Math.min(chunk, r.end - p);
        const hits = edges.filter((e) => e.seg.start < p + n && e.seg.start + e.seg.length > p);
        if (!hits.length) {
          await fh.write(zero, 0, n * BYTES, at);
        } else {
          mixBuf.fill(0, 0, n);
          for (const { seg, fin, fout } of hits) {
            let h = handles.get(seg.file);
            if (!h) {
              const file = join(dir, "segments", seg.file);
              const info = await readWavInfo(file);
              h = { fh: await open(file, "r"), dataOffset: info.dataOffset };
              handles.set(seg.file, h);
            }
            const a = Math.max(p, seg.start);
            const b = Math.min(p + n, seg.start + seg.length);
            const buf = Buffer.alloc((b - a) * BYTES);
            await h.fh.read(buf, 0, buf.length, h.dataOffset + (a - seg.start) * BYTES);
            const L = seg.length;
            const fi = fin ? Math.min(fade, Math.floor(L / 2)) : 0;
            const fo = fout ? Math.min(fade, Math.floor(L / 2)) : 0;
            const off = a - seg.start;
            mix24(buf, b - a, mixBuf, a - p, fi || fo ? (i) => {
              const j = off + i;
              return Math.min(1, fi ? (j + 0.5) / fi : 1, fo ? (L - j - 0.5) / fo : 1);
            } : undefined);
          }
            encode24(mixBuf, 0, n, outBuf);
          await fh.write(outBuf, 0, n * BYTES, at);
          // Done with the segments that end in this chunk: a long show has hundreds per track, and holding
          // them all open runs out of file handles.
          for (const { seg } of hits) {
            if (seg.start + seg.length > p + n) continue;
            const h = handles.get(seg.file);
            if (!h) continue;
            handles.delete(seg.file);
            await h.fh.close();
          }
        }
        at += n * BYTES;
        tick(n);
      }
      await fh.datasync();
    } finally {
      await fh.close();
      for (const h of handles.values()) await h.fh.close();
    }
    await rename(tmp, path);
  }

  private markersCsv(s: RecSession, r: { start: number; end: number }) {
    const rows: [number, string, string][] = [];
    for (const sc of s.scenes) if (sc.start >= r.start && sc.start < r.end) rows.push([sc.start, "scene", `Scene ${sc.code} ${sc.name}`]);
    for (const m of s.markers) if (m.at >= r.start && m.at < r.end) rows.push([m.at, m.kind, m.label]);
    rows.sort((a, b) => a[0] - b[0]);
    const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const clock = (at: number) => new Date(s.startedAt + (at / s.rate) * 1000).toLocaleTimeString([], { hour12: false });
    return ["Time,Seconds,Time of day,Type,Label", ...rows.map(([at, kind, label]) => `${fmtTc((at - r.start) / s.rate)},${((at - r.start) / s.rate).toFixed(3)},${clock(at)},${kind},${q(label)}`)].join("\r\n") + "\r\n";
  }

  private aboutText(s: RecSession, r: { label: string; start: number; end: number }, names: string[], by: string) {
    const sec = (r.end - r.start) / s.rate;
    const start = new Date(s.startedAt + (r.start / s.rate) * 1000);
    return [
      `${s.showName}: ${r.label}`,
      `Recorded by StageMics on ${start.toLocaleDateString()} from ${start.toLocaleTimeString([], { hour12: false })}.`,
      "",
      `${names.length} files, one per ${by === "mic" ? "radio mic" : "person"}, each ${fmtTc(sec)} long (${s.rate} Hz, 24-bit mono WAV).`,
      "Every file starts at the same moment: put them all at the same point on the timeline and they are in sync.",
      "Each file is silent wherever that mic was muted on the desk.",
      "The files are Broadcast WAVs whose time stamp is the time of day they start, for syncing to camera timecode.",
      "markers.csv lists the scenes, cues and marks with their times.",
      "",
      ...names.map((n) => `- ${n}`),
      "",
    ].join("\r\n");
  }
}
