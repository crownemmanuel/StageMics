// Build → Dante audio: where the mics' audio comes from (the Dante Virtual Soundcard on this computer),
// which Dante channel carries each mic, channels recorded the whole time, and the no-signal level.
// Nothing here writes to the desk.

import { useEffect, useState } from "react";
import { holderOf } from "../../../server/logic.ts";
import type { AudioSourceKind } from "../../../server/model.ts";
import { cmd, toast, useOp } from "../lib/store.ts";
import { Dot, Icon, MeterBar, cx } from "../lib/ui.tsx";
import { Card, EditText, IconBtn } from "./BuildMode.tsx";

interface Device {
  name: string;
  channels: number;
  rates: number[];
  defaultRate: number;
  default: boolean;
}

export function DantePage() {
  const settings = useOp((s) => s.settings)!;
  const rt = useOp((s) => s.runtime)!;
  const au = settings.audio;
  const st = rt.audio;
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [listErr, setListErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const refresh = async () => {
    setLoading(true);
    try {
      const r = await cmd<{ devices: Device[] }>("audio.devices", {}, { quiet: true });
      setDevices(r.devices);
      setListErr(null);
    } catch (e) {
      setListErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (au.source === "device") void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [au.source]);
  const set = (patch: Record<string, unknown>) => void cmd("settings.audio", patch);
  const pickSource = (source: AudioSourceKind) => {
    if (source === "device" && !au.device) {
      void refresh();
    }
    set({ source });
  };
  const color = st.status === "running" ? (st.silent ? "#FFB547" : "#B8F25C") : st.status === "starting" ? "#FFB547" : st.status === "error" ? "#FF6B5E" : "#5A6273";
  const statusText = st.status === "running" ? `${st.device} · ${(st.rate ?? 0) / 1000} kHz · reading ${st.channels.length} channels${st.gaps ? ` · ${st.gaps} dropouts` : ""}` : st.status === "starting" ? "Starting…" : st.status === "error" ? st.error ?? "Error" : "Off: no meters, no signal alerts, no recording";
  const dante = devices?.find((d) => /dante/i.test(d.name));
  const current = devices?.find((d) => d.name === au.device);
  const mics = useOp((s) => s.show!.mics);
  const highest = Math.max(0, ...mics.map((m) => m.dante ?? 0));
  return (
    <>
      <h1 className="text-[40px] leading-[1.1] font-black">Dante audio</h1>
      <span className="-mt-3 max-w-[900px] text-[15px] font-extrabold text-muted">
        With the mics' audio on this computer, StageMics shows each pack's signal (and warns when the next scene's packs are silent), and the Recorder records one track per character. It only listens: nothing here changes the desk.
      </span>
      <Card title="Input" right={<span className="inline-flex items-center gap-2 rounded-full bg-card px-3 py-1.5 text-[13px] font-black"><Dot color={color} size={9} />{st.status}</span>}>
        <div className="flex self-start rounded-full bg-well p-1">
          {(["device", "test", "off"] as const).map((k) => (
            <button key={k} type="button" onClick={() => pickSource(k)} className={cx("rounded-full px-5 py-2.5 text-[15px]", au.source === k ? "bg-text font-black text-ink" : "font-extrabold text-dim")}>
              {k === "device" ? "Dante Virtual Soundcard" : k === "test" ? "Test signal" : "Off"}
            </button>
          ))}
        </div>
        {au.source === "device" && (
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex min-w-0 flex-[1_1_320px] flex-col gap-1.5 text-[13px] font-extrabold text-muted">
              Audio device
              <select className="field w-full" value={au.device} onChange={(e) => set({ device: e.target.value })}>
                <option value="">{devices ? "Choose…" : "Loading the devices…"}</option>
                {au.device && !current && <option value={au.device}>{au.device} (not found now)</option>}
                {devices?.map((d) => (
                  <option key={d.name} value={d.name}>
                    {d.name} · {d.channels} ch{/dante/i.test(d.name) ? "  ← Dante" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-[13px] font-extrabold text-muted">
              Sample rate
              <select className="field w-[220px]" value={au.rate} onChange={(e) => set({ rate: Number(e.target.value) })}>
                <option value={0}>As Dante runs (recommended)</option>
                {[44100, 48000, 88200, 96000].map((r) => (
                  <option key={r} value={r}>
                    {r / 1000} kHz
                  </option>
                ))}
              </select>
            </label>
            <button type="button" disabled={loading} onClick={() => void refresh()} className="inline-flex h-11 items-center gap-2 rounded-[14px] bg-chip px-4 text-[15px] font-black disabled:opacity-50">
              <Icon name="sync" size={16} />
              {loading ? "Looking…" : "Find devices"}
            </button>
            <button type="button" onClick={() => set({ restart: true })} className="h-11 rounded-[14px] bg-chip px-4 text-[15px] font-black">
              Restart input
            </button>
          </div>
        )}
        {au.source === "device" && dante && au.device !== dante.name && (
          <button type="button" onClick={() => set({ device: dante.name })} className="self-start rounded-[14px] bg-lime px-4 py-2.5 text-[15px] font-black text-ink">
            Use {dante.name} ({dante.channels} channels)
          </button>
        )}
        {au.source === "device" && devices && !dante && <span className="text-[14px] font-extrabold text-amber">No Dante device on this computer yet. Install and start Dante Virtual Soundcard, then press Find devices.</span>}
        {listErr && <span className="text-[14px] font-extrabold text-coral-text">{listErr}</span>}
        {current && highest > current.channels && <span className="text-[14px] font-extrabold text-coral-text">{current.name} has {current.channels} channels, but a mic is set to Dante channel {highest}. Raise the channel count in Dante Virtual Soundcard.</span>}
        <span className="text-[15px] font-extrabold" style={{ color }}>
          {statusText}
        </span>
        {st.status === "running" && st.silent && au.source === "device" && (
          <div className="rounded-2xl bg-amber-bg px-4 py-3 text-[15px] font-black text-amber-text">
            Every channel is pure silence. Is Dante Virtual Soundcard started and receiving (Dante Controller)? On a Mac, StageMics needs microphone access: System Settings → Privacy &amp; Security → Microphone.
          </div>
        )}
        {au.source === "test" && <span className="text-[13px] font-extrabold text-ghost">A pretend Dante feed for trying the meters and the recorder without a desk: a tone per channel, coming and going like speech. Switch a pack off below to see the no-signal warnings.</span>}
      </Card>

      <MicChannels />
      <AlwaysTracks />

      <Card title="No signal">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[15px] font-extrabold">A pack counts as off when its level stays below</span>
          <EditText value={String(au.noSignalDb)} onCommit={(v) => Number.isFinite(Number(v)) && set({ noSignalDb: Number(v) })} className="field h-10 w-[80px] px-2 text-center text-base" ariaLabel="No-signal level" maxLength={4} />
          <span className="text-[15px] font-extrabold">dBFS for 2 seconds.</span>
        </div>
        <span className="text-[13px] font-extrabold text-ghost">A receiver whose pack is off sends digital silence; a pack that is on sends at least room noise. If packs that are on show "no signal", lower this (−80); if switched-off packs still show signal, raise it (−60).</span>
      </Card>

      <Card title="Setting up Dante">
        <ol className="flex list-decimal flex-col gap-2 pl-6 text-[15px] font-extrabold text-dim">
          <li>Install Dante Virtual Soundcard on this computer and start it (Core Audio on a Mac, WDM on Windows) with at least as many channels as there are mics, at 48 kHz.</li>
          <li>On the dLive, patch each radio mic to a Dante output from its <b className="text-text">input socket / preamp</b> (or a direct out that does not follow the mute), so StageMics hears a pack even while it is muted. StageMics does the muting in the recording.</li>
          <li>In Dante Controller, route those dLive Dante outputs to this computer's receive channels, in mic order if you can (mic 1 → channel 1…).</li>
          <li>Pick the device above and check each mic's meter moves when someone taps the mic.</li>
        </ol>
      </Card>
    </>
  );
}

function MicChannels() {
  const show = useOp((s) => s.show)!;
  const rt = useOp((s) => s.runtime)!;
  const meters = useOp((s) => s.meters);
  const test = useOp((s) => s.settings!.audio.source === "test");
  const [base, setBase] = useState("1");
  const setAll = () => {
    const b = Math.round(Number(base));
    if (!(b >= 1 && b <= 512)) return;
    void cmd("mics.set", { mics: show.mics.map((m, i) => ({ n: m.n, dante: b + i })) }).then(() => toast(`Mics 1–${show.mics.length} on Dante ${b}–${b + show.mics.length - 1}`));
  };
  return (
    <Card
      title="Mics on Dante"
      right={
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setAll();
          }}
        >
          <span className="text-[13px] font-extrabold text-muted">Mic 1 on channel</span>
          <input value={base} onChange={(e) => setBase(e.target.value.replace(/\D/g, "").slice(0, 3))} inputMode="numeric" aria-label="Dante channel of mic 1" className="field h-10 w-[64px] px-2 text-center text-sm" />
          <button type="submit" className="rounded-[14px] bg-chip px-3.5 py-2 text-[14px] font-black">
            Number them in order
          </button>
        </form>
      }
    >
      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(380px, 1fr))" }}>
        {show.mics.map((m) => {
          const h = holderOf(show, null, m.n);
          const sig = rt.signal?.[m.n];
          const off = test && m.dante != null && sig === false;
          return (
            <div key={m.n} className="flex items-center gap-2.5 rounded-[14px] bg-raise px-3 py-2.5">
              <span className="inline-flex h-[30px] min-w-[34px] items-center justify-center rounded-[9px] bg-chip text-sm font-black">{m.n}</span>
              <span className="w-[90px] truncate text-[15px] font-extrabold">{h?.char.name ?? <span className="text-ghost">nobody</span>}</span>
              <span className="text-xs font-extrabold text-muted">Dante</span>
              <EditText value={m.dante == null ? "" : String(m.dante)} placeholder="–" onCommit={(v) => void cmd("mics.set", { mics: [{ n: m.n, dante: v === "" ? null : Number(v) }] })} className="field h-9 w-[58px] px-2 text-center text-sm" ariaLabel={`Dante channel for mic ${m.n}`} maxLength={3} />
              <MeterBar value={meters?.mics[m.n]} className="min-w-[60px] flex-1" />
              <span className="w-[64px] text-right text-[11px] font-black">{m.dante == null ? <span className="text-ghost">off</span> : sig === undefined ? <span className="text-ghost">—</span> : sig ? <span className="text-lime">signal</span> : <span className="text-amber">NO SIGNAL</span>}</span>
              {test && m.dante != null && (
                <button type="button" onClick={() => void cmd("audio.testSignal", { channel: m.dante, on: off })} className="rounded-lg bg-chip px-2 py-1 text-[11px] font-black text-soft" title="Test signal: switch this pretend pack on or off">
                  {off ? "pack on" : "pack off"}
                </button>
              )}
            </div>
          );
        })}
      </div>
      <span className="text-[13px] font-extrabold text-ghost">Leave a channel empty for a mic that is not on Dante (it is then not metered or recorded). Changing channels restarts the input: a short gap if it is recording.</span>
    </Card>
  );
}

function AlwaysTracks() {
  const show = useOp((s) => s.show)!;
  const meters = useOp((s) => s.meters);
  const [name, setName] = useState("");
  const [ch, setCh] = useState("");
  const save = (tracks: { id?: string; name: string; dante: number }[]) => void cmd("rec.tracks", { tracks });
  return (
    <Card title="Always recorded">
      <span className="text-[14px] font-extrabold text-muted">Channels the recorder keeps the whole time, whatever the mutes: a reference mix for the editor, audience or ambience mics.</span>
      {show.recTracks.map((t) => (
        <div key={t.id} className="flex items-center gap-3 rounded-[14px] bg-raise px-3 py-2.5">
          <span className="w-[160px] truncate text-[15px] font-black">{t.name}</span>
          <span className="text-xs font-extrabold text-muted">Dante {t.dante}</span>
          <MeterBar value={meters?.tracks[t.id]} className="flex-1" />
          <IconBtn icon="trash" label={`Remove ${t.name}`} onClick={() => save(show.recTracks.filter((x) => x.id !== t.id))} />
        </div>
      ))}
      <form
        className="flex flex-wrap items-center gap-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          const c = Number(ch);
          if (!name.trim() || !(c >= 1 && c <= 512)) return;
          save([...show.recTracks, { name: name.trim(), dante: c }]);
          setName("");
          setCh("");
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value.slice(0, 30))} placeholder="Mix L" aria-label="Track name" className="field h-10 w-[180px]" />
        <span className="text-[13px] font-extrabold text-muted">on Dante channel</span>
        <input value={ch} onChange={(e) => setCh(e.target.value.replace(/\D/g, "").slice(0, 3))} inputMode="numeric" placeholder="33" aria-label="Dante channel" className="field h-10 w-[70px] px-2 text-center" />
        <button type="submit" disabled={!name.trim() || !ch} className="inline-flex items-center gap-2 rounded-[14px] bg-lime px-4 py-2 text-[15px] font-black text-ink disabled:opacity-40">
          <Icon name="plus" size={16} stroke={2.6} />
          Add
        </button>
      </form>
    </Card>
  );
}
