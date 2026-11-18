// Operator screen ⇄ service: one WebSocket with state snapshots / patches and commands. A command sent
// while the socket is down goes over HTTP instead, so MUTE ALL never depends on the socket.

import { useSyncExternalStore } from "react";
import type { MeterFrame, Runtime, Settings, SoundShow } from "../../../server/model.ts";

export interface Links {
  ip: string;
  local: string;
  cloud: string | null;
  hosted: boolean;
  active: string | null;
}

export interface OpState {
  connected: boolean;
  show: SoundShow | null;
  runtime: Runtime | null;
  pending: Record<string, boolean>;
  settings: Settings | null;
  links: Links | null;
  log: { at: number; msg: string }[];
  toast: { text: string; bad: boolean; at: number } | null;
  /** Levels and the recorder's pulse, ~10 a second while the Dante input runs (null when it does not). */
  meters: MeterFrame | null;
}

let state: OpState = { connected: false, show: null, runtime: null, pending: {}, settings: null, links: null, log: [], toast: null, meters: null };
const subs = new Set<() => void>();
const set = (patch: Partial<OpState>) => {
  state = { ...state, ...patch };
  for (const f of subs) f();
};

export function useOp<T>(pick: (s: OpState) => T): T {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => pick(state),
  );
}
export const getOp = () => state;

let ws: WebSocket | null = null;
let nextId = 1;
const waiting = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

/** The service sends something at least every 5 s (a heartbeat when nothing else): silence this long means it is gone. */
const SILENT_MS = 15000;
let lastHeard = 0;

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const sock = new WebSocket(`${proto}://${location.host}/ws?role=operator`);
  ws = sock;
  let dropped = false;
  // Once per socket, whether it closed or the watchdog gave up on it.
  const drop = () => {
    if (dropped) return;
    dropped = true;
    clearInterval(watch);
    if (ws === sock) ws = null;
    set({ connected: false });
    for (const [id, w] of waiting) {
      clearTimeout(w.timer);
      w.fail(new Error("Lost the connection to the Sound service"));
      waiting.delete(id);
    }
    setTimeout(connect, 800);
  };
  // A frozen service or a dead link can leave the socket "open" for minutes: the screen must say so.
  const watch = setInterval(() => {
    if (sock.readyState === WebSocket.OPEN && Date.now() - lastHeard > SILENT_MS) {
      drop();
      try {
        sock.close();
      } catch {
        /* already closing */
      }
    }
  }, 2000);
  sock.onopen = () => {
    lastHeard = Date.now();
    set({ connected: true });
  };
  sock.onclose = drop;
  sock.onmessage = (e) => {
    if (dropped) return;
    lastHeard = Date.now();
    let m;
    try {
      m = JSON.parse(String(e.data));
    } catch {
      return;
    }
    if (m.t === "hb") return;
    if (m.t === "state") set({ show: m.show, runtime: m.runtime, pending: m.pending ?? {}, settings: m.settings, links: m.links, log: m.log ?? [] });
    else if (m.t === "patch") {
      const p: Partial<OpState> = {};
      if (m.show) p.show = m.show;
      if (m.runtime) p.runtime = m.runtime;
      if (m.pending) p.pending = m.pending;
      if (m.settings) p.settings = m.settings;
      if (m.links) p.links = m.links;
      // The input stopped: its last levels must not stay on screen.
      if (m.runtime && m.runtime.audio.status !== "running" && state.meters) p.meters = null;
      set(p);
    } else if (m.t === "meters") set({ meters: m.frame });
    else if (m.t === "log") set({ log: [...state.log.slice(-150), m.line] });
    else if (m.t === "res") {
      const w = waiting.get(m.id);
      if (!w) return;
      waiting.delete(m.id);
      clearTimeout(w.timer);
      if (m.ok) w.ok(m.result);
      else w.fail(new Error(m.error));
    }
  };
}
connect();

/** Run a command on the service. Errors show as a toast unless `quiet`. */
export async function cmd<T = unknown>(name: string, args: Record<string, unknown> = {}, opts: { quiet?: boolean } = {}): Promise<T> {
  try {
    return (await rawCmd(name, args)) as T;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!opts.quiet) toast(msg, true);
    throw e;
  }
}

function rawCmd(name: string, args: Record<string, unknown>): Promise<unknown> {
  const sock = ws;
  if (sock && sock.readyState === WebSocket.OPEN) {
    const id = nextId++;
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        fail(new Error(`${name}: no answer from the Sound service`));
      }, name === "mics.detect" || name === "import.livestage" || name === "audio.devices" || name === "rec.stop" ? 20000 : 6000);
      waiting.set(id, { ok, fail, timer });
      sock.send(JSON.stringify({ t: "cmd", id, cmd: name, args }));
    });
  }
  return http(name, args);
}

async function http(name: string, args: Record<string, unknown>) {
  const r = await fetch("/api/cmd", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cmd: name, args }) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error);
  return j.result;
}

/** MUTE ALL: straight out on whatever path is open, and over HTTP as well (muting twice is harmless). */
export function panic() {
  const sock = ws;
  if (sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ t: "cmd", id: 0, cmd: "panic", args: {} }));
  void http("panic", {}).catch(() => toast("MUTE ALL could not reach the Sound service", true));
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function toast(text: string, bad = false) {
  set({ toast: { text, bad, at: Date.now() } });
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => set({ toast: null }), bad ? 5000 : 2500);
}
