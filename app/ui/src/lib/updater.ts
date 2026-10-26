// App updates from the GitHub releases (docs/RELEASES.md), in the desktop app only.
//
// Nothing here downloads, installs or restarts on its own: the background check only says that a newer
// version exists. Installing is the operator's press, and it is refused while a scene is active (the
// restart stops the mic service for a few seconds; the desk keeps every mic as it is meanwhile).

import { useSyncExternalStore } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

export type UpdatePhase = "idle" | "checking" | "current" | "available" | "downloading" | "installing" | "error";

export interface UpdaterState {
  phase: UpdatePhase;
  version: string | null;
  notes: string | null;
  checkedAt: number | null;
  progress: { done: number; total: number } | null;
  error: string | null;
}

export const inDesktopApp = isTauri();

let state: UpdaterState = { phase: "idle", version: null, notes: null, checkedAt: null, progress: null, error: null };
const listeners = new Set<() => void>();
const set = (p: Partial<UpdaterState>) => {
  state = { ...state, ...p };
  listeners.forEach((l) => l());
};
export const useUpdater = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );

let pending: Update | null = null;

const message = (e: unknown) => {
  const t = e instanceof Error ? e.message : String(e);
  return /valid release JSON|404/i.test(t) ? "No published release found on GitHub yet." : t;
};

/** Ask GitHub whether a newer version exists. Downloads nothing. */
export async function checkForUpdate(quiet = false) {
  if (!inDesktopApp || state.phase === "downloading" || state.phase === "installing") return;
  if (!quiet) set({ phase: "checking", error: null });
  try {
    const u = await check({ timeout: 20_000 });
    pending = u;
    set(u ? { phase: "available", version: u.version, notes: u.body ?? null, checkedAt: Date.now(), error: null } : { phase: "current", version: null, notes: null, checkedAt: Date.now(), error: null });
  } catch (e) {
    if (quiet) set({ checkedAt: Date.now() });
    else set({ phase: "error", error: message(e), checkedAt: Date.now() });
  }
}

/** Download, stop the mic service, install and restart. `liveScene`: refuse while one is active. */
export async function installUpdate(liveScene: string | null) {
  if (!pending) return;
  if (liveScene) {
    set({ error: `Scene ${liveScene} is active. End the scene first, then install.` });
    return;
  }
  set({ phase: "downloading", progress: { done: 0, total: 0 }, error: null });
  try {
    let done = 0;
    let total = 0;
    await pending.download((ev) => {
      if (ev.event === "Started") total = ev.data.contentLength ?? 0;
      else if (ev.event === "Progress") done += ev.data.chunkLength;
      set({ progress: { done, total } });
    });
    set({ phase: "installing" });
    // The installer replaces the service's executable too: stop it first (this page keeps running).
    await invoke("stop_for_update");
    await pending.install();
    await relaunch();
  } catch (e) {
    set({ phase: "error", error: message(e) });
  }
}

/** A few seconds after start, then every six hours: just look. */
export function startUpdateChecks() {
  if (!inDesktopApp) return;
  setTimeout(() => void checkForUpdate(true), 8_000);
  setInterval(() => void checkForUpdate(true), 6 * 3600 * 1000);
}
