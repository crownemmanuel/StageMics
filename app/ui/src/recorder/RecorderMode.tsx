// Recorder: record the show, one track per character, following the mutes. The big status says whether audio
// is coming in and reaching the disk right now (look at it any time); the timeline shows who was written
// when; past recordings are exported here (the whole show, every scene, or one scene) for the video editor.

import { useEffect, useRef, useState } from "react";
import { castWithMics, holderOf, micLive, sceneById } from "../../../server/logic.ts";
import type { RecSession, RecStatus, Runtime, SoundShow } from "../../../server/model.ts";
import { Card, EditText } from "../build/BuildMode.tsx";
import { cmd, toast, useOp } from "../lib/store.ts";
import { ask, Dot, Icon, MeterBar, SectionLabel, cx, fmtBytes, fmtClock } from "../lib/ui.tsx";

interface SessionSummary {
  id: string;
  name: string;
  state: RecSession["state"];
  startedAt: number;
  seconds: number;
  folder: string;
  tracks: string[];
  segments: number;
  scenes: { scene: string; code: string; name: string; start: number; end: number | null }[];
  bytes: number;
}

export function RecorderMode() {
  const rt = useOp((s) => s.runtime)!;
  const show = useOp((s) => s.show)!;
  const rec = rt.rec;
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [viewId, setViewId] = useState<string | null>(null);
  const exportsKey = rec.exports.map((e) => `${e.id}:${e.state}`).join();
  const last = useRef(0);
  // The list follows starts, stops, finished exports and (at most every 2 s) the current recording's segments.
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      last.current = Date.now();
      void cmd<SessionSummary[]>("rec.sessions", {}, { quiet: true }).then((l) => live && setSessions(l), () => {});
    }, Math.max(0, 2000 - (Date.now() - last.current)));
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [rec.state, rec.session?.id, exportsKey, rec.rev]);
  const shownId = viewId ?? rec.session?.id ?? sessions[0]?.id ?? null;
  return (
    <main className="flex min-w-0 flex-1 flex-col gap-6 px-7 pt-6 pb-10">
      <Hero rt={rt} show={show} />
      {shownId && <Timeline id={shownId} live={rec.state === "recording" && shownId === rec.session?.id} rev={rec.rev} show={show} />}
      <div className="grid gap-5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(440px, 1fr))" }}>
        <MicsNow rt={rt} show={show} />
        <Recordings sessions={sessions} rec={rec} viewing={shownId} onView={setViewId} />
      </div>
      <RecorderSettings rec={rec} />
    </main>
  );
}

// ---------------------------------------------------------------- the big status

function Hero({ rt, show }: { rt: Runtime; show: SoundShow }) {
  const rec = rt.rec;
  const audio = rt.audio;
  const pulse = useOp((s) => s.meters?.rec ?? null);
  const [, tick] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 500);
    return () => clearInterval(t);
  }, []);
  const recording = rec.state === "recording";
  const sec = pulse && pulse.rate ? pulse.pos / pulse.rate : rec.session && recording ? (Date.now() - rec.session.startedAt) / 1000 : 0;
  const writeAge = pulse && pulse.writeAgo !== null ? pulse.writeAgo / 1000 : null;
  const audioOk = audio.status === "running";
  const writing = rec.open.length;
  // One plain sentence: is it working right now?
  let health: { text: string; color: string };
  if (!recording) health = audioOk ? { text: `Ready: ${audio.device} · ${(audio.rate ?? 0) / 1000} kHz · ${audio.channels.length} channels`, color: "#B8F25C" } : audio.source === "off" ? { text: "The Dante input is off: turn it on in Build → Dante", color: "#FFB547" } : { text: audio.error ?? "Waiting for the Dante input…", color: "#FF6B5E" };
  else if (!audioOk) health = { text: `No audio coming in${audio.error ? ` (${audio.error})` : ""}: the recording carries on as soon as it is back`, color: "#FF6B5E" };
  else if (writing && writeAge !== null && writeAge > 3) health = { text: `Nothing reached the disk for ${Math.round(writeAge)} s`, color: "#FF6B5E" };
  else if (writing) health = { text: `Recording: ${writing} ${writing === 1 ? "track" : "tracks"} going to disk${writeAge !== null ? ` · last write ${writeAge.toFixed(1)} s ago` : ""}`, color: "#B8F25C" };
  else health = { text: "Recording: every mic is muted, so nothing is written (the clock keeps running)", color: "#B8F25C" };
  const start = async () => {
    setBusy(true);
    try {
      await cmd("rec.start");
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    if (!(await ask("Stop recording? The files are kept; you can export them below.", { ok: "Stop recording" }))) return;
    setBusy(true);
    try {
      await cmd("rec.stop");
      toast("Recording stopped and saved");
    } finally {
      setBusy(false);
    }
  };
  const mark = async () => {
    const r = await cmd<{ at: number }>("rec.mark", { label: `Mark at ${fmtClock(sec, true)}` });
    toast(`Marked at ${fmtClock(r.at, true)}`);
  };
  return (
    <section className="flex flex-col gap-4 rounded-[28px] border-2 p-6" style={{ borderColor: recording ? "#5A1E22" : "#1E232D", background: recording ? "#1A0E11" : "#12151C" }}>
      <div className="flex flex-wrap items-center gap-6">
        {recording ? (
          <span className="inline-flex items-center gap-3 rounded-full bg-[#3A1216] px-5 py-3 text-[22px] font-black tracking-[2px] text-[#FF8E84]">
            <span className="size-4 animate-pulse rounded-full bg-[#FF4B3E]" />
            REC
          </span>
        ) : (
          <span className="inline-flex items-center gap-3 rounded-full bg-chip px-5 py-3 text-[22px] font-black tracking-[2px] text-muted">
            <span className="size-4 rounded-full bg-ghost" />
            STOPPED
          </span>
        )}
        <span className="text-[64px] leading-none font-black tabular-nums" aria-label="Recording time">
          {fmtClock(sec, true)}
        </span>
        <span className="flex min-w-0 flex-[1_1_240px] flex-col gap-1">
          <span className="truncate text-xl font-black">{recording ? rec.session?.name : "Not recording"}</span>
          <span className="inline-flex items-center gap-2 text-[15px] font-extrabold" style={{ color: health.color }}>
            <Dot color={health.color} />
            {health.text}
          </span>
          {rec.disk && <span className="text-[13px] font-extrabold text-ghost">{fmtBytes(rec.disk.free)} free on the recording disk</span>}
        </span>
        <div className="flex flex-wrap gap-3">
          {recording ? (
            <>
              <button type="button" onClick={() => void mark()} className="inline-flex items-center gap-2 rounded-[20px] border-2 border-line2 px-5 py-4 text-lg font-black text-soft">
                <Icon name="flag" />
                Mark
              </button>
              <button type="button" disabled={busy} onClick={() => void stop()} className="inline-flex items-center gap-2.5 rounded-[20px] border-2 border-coral px-6 py-4 text-xl font-black text-coral-text disabled:opacity-50">
                <Icon name="stop" stroke={2.6} />
                Stop
              </button>
            </>
          ) : (
            <button type="button" disabled={busy || audio.source === "off"} onClick={() => void start()} className="inline-flex items-center gap-3 rounded-[20px] bg-[#FF4B3E] px-8 py-4 text-xl font-black text-white disabled:opacity-40">
              <Icon name="rec" size={22} />
              Record
            </button>
          )}
        </div>
      </div>
      {rec.resumed && recording && (
        <div className="rounded-2xl bg-amber-bg px-4 py-3 text-[15px] font-black text-amber-text">
          The app restarted at {new Date(rec.resumed.at).toLocaleTimeString()} and the recording carried on{rec.resumed.lostSeconds ? `; ${rec.resumed.lostSeconds} s are silent where it was away` : ""}.
        </div>
      )}
      {rec.error && <div className="rounded-2xl bg-coral-bg px-4 py-3 text-[15px] font-black text-coral-text">{rec.error}</div>}
      {rec.warnings.map((w) => (
        <div key={w} className="flex items-center gap-2 rounded-2xl bg-amber-bg px-4 py-3 text-[15px] font-black text-amber-text">
          <Icon name="warn" size={18} />
          {w}
        </div>
      ))}
      {recording && rec.open.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-extrabold tracking-[1.5px] text-muted">WRITING</span>
          {rec.open.map((o) => (
            <span key={o.key} className="inline-flex items-center gap-1.5 rounded-full bg-[#3A1216] px-3 py-1.5 text-sm font-black text-[#FFB3AB]">
              <span className="size-2 rounded-full bg-[#FF4B3E]" />
              {o.name}
              {o.mic != null && <span className="text-[#FF8E84]/70">· mic {o.mic}</span>}
            </span>
          ))}
        </div>
      )}
      {!recording && (
        <span className="text-[15px] font-extrabold text-muted">
          Record makes one track per character for the whole show. A mic is written only while it is live on the desk; muted time stays silent. {show.recTracks.length ? `Also recorded the whole time: ${show.recTracks.map((t) => t.name).join(", ")}.` : ""}
        </span>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- timeline

const LANE_ORDER = (k: string, show: SoundShow) => (k.startsWith("char:") ? show.characters.findIndex((c) => c.id === k.slice(5)) : k.startsWith("mic:") ? 1000 + Number(k.slice(4)) : 2000);

/** Who was written when: one lane per track, scenes on top. Fetched again whenever the recorder's rev moves. */
function Timeline({ id, live, rev, show }: { id: string; live: boolean; rev: number; show: SoundShow }) {
  const [s, setS] = useState<RecSession | null>(null);
  const pulse = useOp((st) => (live ? st.meters?.rec ?? null : null));
  const last = useRef(0);
  useEffect(() => {
    let alive = true;
    const wait = Math.max(0, 700 - (Date.now() - last.current));
    const t = setTimeout(() => {
      last.current = Date.now();
      void cmd<RecSession>("rec.session", { session: id }, { quiet: true }).then((x) => alive && setS(x), () => alive && setS(null));
    }, wait);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [id, rev]);
  if (!s || !s.rate) return null;
  const end = Math.max(s.length, live && pulse ? pulse.pos : 0, 1);
  const lanes = Object.values(s.tracks).sort((a, b) => LANE_ORDER(a.id, show) - LANE_ORDER(b.id, show) || a.name.localeCompare(b.name));
  const pct = (f: number) => `${(Math.max(0, Math.min(end, f)) / end) * 100}%`;
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <section aria-label="Timeline" className="flex flex-col gap-3 rounded-3xl border border-line bg-panel p-5">
      <div className="flex flex-wrap items-center gap-3">
        <SectionLabel>{live ? "This recording so far" : s.name}</SectionLabel>
        <span className="text-[13px] font-extrabold text-ghost">{Object.keys(s.tracks).length} tracks · {s.segments.length} segments · silence wherever a lane is empty</span>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-3">
          <span className="w-[130px] flex-none text-xs font-black text-muted">SCENES</span>
          <div className="relative h-7 flex-1 rounded-lg bg-well">
            {s.scenes.map((r, i) => (
              <div key={i} title={`Scene ${r.code} ${r.name}`} className="absolute inset-y-0 flex items-center overflow-hidden rounded-md border border-[#2F6F7A] bg-cyan-bg px-1.5 text-[11px] font-black text-cyan-text" style={{ left: pct(r.start), width: `calc(${pct((r.end ?? end) - r.start)} - 1px)` }}>
                <span className="truncate">{r.code}</span>
              </div>
            ))}
          </div>
        </div>
        {lanes.map((t) => (
          <div key={t.id} className="flex items-center gap-3">
            <span className="w-[130px] flex-none truncate text-sm font-black" title={t.name}>
              {t.name}
              {t.kind === "always" && <span className="ml-1 text-[11px] text-ghost">always</span>}
            </span>
            <div className="relative h-6 flex-1 rounded-lg bg-well">
              {s.segments
                .filter((g) => g.track === t.id)
                .map((g) => {
                  const len = g.open && live && pulse ? Math.max(g.length, pulse.pos - g.start) : g.length;
                  return <div key={g.id} title={`${t.name}${g.mic != null ? ` · mic ${g.mic}` : ""} · ${fmtClock(g.start / s.rate, true)}–${fmtClock((g.start + len) / s.rate, true)}${g.recovered ? " · recovered after a restart" : ""}`} className="absolute inset-y-1 rounded" style={{ left: pct(g.start), width: `max(2px, ${pct(len)})`, background: g.open ? "#FF4B3E" : t.kind === "always" ? "#5A6273" : "#B8F25C" }} />;
                })}
            </div>
          </div>
        ))}
        {!lanes.length && <div className="py-3 text-[15px] font-extrabold text-ghost">Nobody has been live yet.</div>}
        <div className="flex items-center gap-3">
          <span className="w-[130px] flex-none" />
          <div className="relative h-5 flex-1">
            {s.markers
              .filter((m) => m.kind !== "cue")
              .map((m, i) => (
                <span key={i} title={`${fmtClock(m.at / s.rate, true)} ${m.label}`} className="absolute top-0 -translate-x-1/2 text-[11px] font-black" style={{ left: pct(m.at), color: m.kind === "gap" ? "#FF8E84" : "#FFD58F" }}>
                  ▲
                </span>
              ))}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="w-[130px] flex-none" />
          <div className="relative h-4 flex-1 text-[11px] font-extrabold text-ghost">
            {ticks.map((k) => (
              <span key={k} className="absolute" style={{ left: `${k * 100}%`, transform: k === 0 ? undefined : k === 1 ? "translateX(-100%)" : "translateX(-50%)" }}>
                {fmtClock((end * k) / s.rate, true)}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- mics right now

function MicsNow({ rt, show }: { rt: Runtime; show: SoundShow }) {
  const meters = useOp((s) => s.meters);
  const scene = sceneById(show, rt.activeSceneId);
  const writing = new Set(rt.rec.open.map((o) => o.key));
  const inScene = new Set(scene ? castWithMics(show, scene).map((c) => c.mic) : []);
  return (
    <Card title="Mics" right={<span className="text-[13px] font-extrabold text-muted">{scene ? `Scene ${scene.code} live` : "No scene live"}</span>}>
      <div className="flex flex-col gap-1.5">
        {show.mics.map((m) => {
          const h = holderOf(show, scene, m.n);
          const live = micLive(show, rt, m.n);
          const sig = rt.signal?.[m.n];
          const rec = writing.has(`m:${m.n}`);
          return (
            <div key={m.n} className="flex items-center gap-3 rounded-[14px] px-2.5 py-1.5" style={{ background: inScene.has(m.n) ? "#181C25" : "transparent" }}>
              <span className="inline-flex h-[28px] min-w-[32px] items-center justify-center rounded-[9px] bg-chip text-sm font-black">{m.n}</span>
              <span className={cx("w-[110px] truncate text-[15px] font-black", !h && "text-ghost")}>{h?.char.name ?? "nobody"}</span>
              <MeterBar value={meters?.mics[m.n]} on={live === true} className="flex-1" />
              <span className="w-[74px] text-right text-[11px] font-black">
                {m.dante == null ? <span className="text-ghost">not on Dante</span> : sig === false ? <span className="text-amber">NO SIGNAL</span> : <span className="text-ghost">Dante {m.dante}</span>}
              </span>
              <span className="inline-flex w-[54px] justify-end">
                {rec ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-[#3A1216] px-2 py-0.5 text-[11px] font-black text-[#FF8E84]">
                    <span className="size-1.5 rounded-full bg-[#FF4B3E]" />
                    REC
                  </span>
                ) : (
                  <span className="text-[11px] font-black" style={{ color: live ? "#B8F25C" : "#5A6273" }}>
                    {live === undefined ? "?" : live ? "LIVE" : "muted"}
                  </span>
                )}
              </span>
            </div>
          );
        })}
        {show.recTracks.map((t) => (
          <div key={t.id} className="flex items-center gap-3 rounded-[14px] px-2.5 py-1.5">
            <span className="inline-flex h-[28px] min-w-[32px] items-center justify-center rounded-[9px] bg-chip text-[11px] font-black text-muted">ALL</span>
            <span className="w-[110px] truncate text-[15px] font-black">{t.name}</span>
            <MeterBar value={meters?.tracks[t.id]} className="flex-1" />
            <span className="w-[74px] text-right text-[11px] font-black text-ghost">Dante {t.dante}</span>
            <span className="inline-flex w-[54px] justify-end">{writing.has(`t:${t.id}`) && <span className="rounded-full bg-[#3A1216] px-2 py-0.5 text-[11px] font-black text-[#FF8E84]">REC</span>}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- recordings and export

function Recordings({ sessions, rec, viewing, onView }: { sessions: SessionSummary[]; rec: RecStatus; viewing: string | null; onView: (id: string) => void }) {
  return (
    <Card title="Recordings" right={<button type="button" onClick={() => void cmd("rec.reveal", { session: null, sub: undefined }).catch(() => {})} className="inline-flex items-center gap-2 rounded-[14px] bg-chip px-3.5 py-2 text-[14px] font-black"><Icon name="folder" size={16} />Folder</button>}>
      {!sessions.length && <span className="text-[15px] font-extrabold text-ghost">No recordings yet. They go to {rec.folder}.</span>}
      <div className="flex flex-col gap-3">
        {sessions.map((s) => (
          <SessionCard key={s.id} s={s} rec={rec} viewing={viewing === s.id} onView={() => onView(s.id)} />
        ))}
      </div>
    </Card>
  );
}

function SessionCard({ s, rec, viewing, onView }: { s: SessionSummary; rec: RecStatus; viewing: boolean; onView: () => void }) {
  const [byMic, setByMic] = useState(false);
  const live = rec.state === "recording" && rec.session?.id === s.id;
  const pulse = useOp((st) => (live ? st.meters?.rec ?? null : null));
  const seconds = live && pulse?.rate ? pulse.pos / pulse.rate : s.seconds;
  const jobs = rec.exports.filter((e) => e.session === s.id);
  const scenes = [...new Map(s.scenes.map((r) => [r.scene, r])).values()];
  const exp = (scope: string) => void cmd("rec.export", { session: s.id, scope, by: byMic ? "mic" : "character" }).then(() => toast("Exporting…"), () => {});
  const badge = live ? { t: "RECORDING", bg: "#3A1216", c: "#FF8E84" } : s.state === "interrupted" ? { t: "CLOSED AFTER A STOP", bg: "#3A2A0E", c: "#FFD58F" } : { t: "DONE", bg: "#182016", c: "#B8F25C" };
  return (
    <div className="flex flex-col gap-3 rounded-[20px] border-2 bg-raise p-4" style={{ borderColor: viewing ? "#3A4256" : "transparent" }}>
      <div className="flex flex-wrap items-center gap-2.5">
        <button type="button" onClick={onView} className="min-w-0 flex-1 text-left">
          <span className="block truncate text-lg font-black">{s.name}</span>
          <span className="text-[13px] font-extrabold text-muted">
            {new Date(s.startedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} · {fmtClock(seconds, true)} · {s.tracks.length} {s.tracks.length === 1 ? "track" : "tracks"} · {fmtBytes(s.bytes)}
          </span>
        </button>
        <span className="rounded-full px-2.5 py-1 text-[11px] font-black tracking-[0.5px]" style={{ background: badge.bg, color: badge.c }}>
          {badge.t}
        </span>
      </div>
      {s.tracks.length > 0 && <span className="text-[13px] font-extrabold text-dim">{s.tracks.join(" · ")}</span>}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={!seconds} onClick={() => exp("show")} className="rounded-[14px] bg-lime px-4 py-2.5 text-[15px] font-black text-ink disabled:opacity-40">
          Export full show
        </button>
        <button type="button" disabled={!scenes.length} onClick={() => exp("scenes")} className="rounded-[14px] bg-chip px-4 py-2.5 text-[15px] font-black disabled:opacity-40">
          Every scene
        </button>
        {scenes.length > 0 && (
          <select className="field h-[42px] w-[190px] text-sm" value="" onChange={(e) => e.target.value && exp(e.target.value)} aria-label="Export one scene">
            <option value="">One scene…</option>
            {scenes.map((r) => (
              <option key={r.scene} value={r.scene}>
                {r.code} · {r.name}
              </option>
            ))}
          </select>
        )}
        <button type="button" onClick={() => void cmd("rec.reveal", { session: s.id }).catch(() => {})} aria-label="Show in Finder" title="Show the folder" className="inline-flex size-[42px] items-center justify-center rounded-[14px] bg-chip">
          <Icon name="folder" size={18} />
        </button>
      </div>
      <label className="flex items-center gap-2 text-[13px] font-extrabold text-muted">
        <input type="checkbox" className="size-4 accent-[#B8F25C]" checked={byMic} onChange={(e) => setByMic(e.target.checked)} />
        One file per radio mic instead of per character
      </label>
      {live && <span className="text-[13px] font-extrabold text-ghost">Exporting now gives everything recorded so far; scenes that have ended are complete.</span>}
      {jobs.map((j) => (
        <div key={j.id} className="flex flex-col gap-1.5 rounded-2xl bg-well p-3">
          <div className="flex items-center gap-2 text-[14px] font-black">
            <span className="flex-1 truncate">
              {j.label}
              {j.state === "done" && <span className="text-lime"> · {j.files} files ready</span>}
              {j.state === "error" && <span className="text-coral-text"> · {j.error}</span>}
            </span>
            {j.state === "done" && (
              <button type="button" onClick={() => void cmd("rec.reveal", { session: s.id, sub: j.sub }).catch(() => {})} className="rounded-xl bg-chip px-3 py-1.5 text-[13px] font-black">
                Open
              </button>
            )}
          </div>
          {j.state === "running" && <MeterBar value={j.progress} />}
        </div>
      ))}
      {s.scenes.length > 0 && (
        <span className="text-[12px] font-extrabold text-ghost">
          Scenes: {s.scenes.map((r) => `${r.code} at ${fmtClock(r.start, true)}`).join(" · ")}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- settings

function RecorderSettings({ rec }: { rec: RecStatus }) {
  const settings = useOp((s) => s.settings)!;
  const r = settings.recorder;
  const recording = rec.state === "recording";
  return (
    <Card title="Recorder settings">
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex min-w-0 flex-[1_1_360px] flex-col gap-1.5 text-[13px] font-extrabold text-muted">
          Recordings folder (an external SSD is a good place)
          <EditText value={r.folder} placeholder={rec.folder} onCommit={(v) => void cmd("settings.recorder", { folder: v })} className="field w-full" ariaLabel="Recordings folder" maxLength={1000} />
        </label>
        <MsField label="Keep before an unmute" value={r.preRollMs} onCommit={(v) => void cmd("settings.recorder", { preRollMs: v })} />
        <MsField label="Keep after a mute" value={r.postRollMs} onCommit={(v) => void cmd("settings.recorder", { postRollMs: v })} />
      </div>
      <span className="text-[13px] font-extrabold text-ghost">
        {recording ? "Stop the recording to change the folder. " : ""}Now: {rec.folder}. The little extra before and after each mic opens and closes keeps the first and last syllable when the mute lands late; exported files fade in and out over 10 ms there so nothing clicks.
      </span>
    </Card>
  );
}

function MsField({ label, value, onCommit }: { label: string; value: number; onCommit: (v: number) => void }) {
  return (
    <label className="flex flex-col gap-1.5 text-[13px] font-extrabold text-muted">
      {label}
      <span className="flex items-center gap-2">
        <EditText value={String(value)} onCommit={(v) => Number.isFinite(Number(v)) && onCommit(Math.round(Number(v)))} className="field h-11 w-[90px] text-center" ariaLabel={label} maxLength={4} />
        <span className="text-[15px] text-dim">ms</span>
      </span>
    </label>
  );
}

