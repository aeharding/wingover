import { engine } from "../../engine/index";
import { isTauri } from "../../platform/index";
import { describeRejection, SEVERED_IDB } from "../../storage/idbErrors";
import { takeHeal } from "./healBudget";

/**
 * The severed-IndexedDB heal (Voyager's pattern, observed 2026-07-30 on a
 * dev install replacing the bundle under a running webview): every
 * IndexedDB connection severs. Reads fail with "the database connection
 * is closing" or "Connection to Indexed Database server lost", the
 * logbook reads as empty, the WAL cannot hydrate, and sync cannot
 * connect — while every byte on disk is fine. Only a fresh page fixes
 * it, so this is a SANCTIONED location.reload (eslint.config.js ignore
 * list): the broken thing is the process's connection to storage itself.
 *
 * Native only, and the gate is load-bearing SAFETY, not scoping: on the
 * PWA the WAL is the only copy of an in-progress flight, and a wrong
 * reload there is priced entirely differently. On iOS the Rust store
 * replays fixes from its durable queue after any reload.
 *
 * Loop bounds, in order of independence: a minimum page uptime before
 * any heal (caps every conceivable loop, even with localStorage dead), a
 * once-per-window stamp (healBudget, shared mechanism with AppBoundary's
 * crash heal, separate key), and a terminal count (two heals in ten
 * minutes and this module stops healing for the session; if the WAL is
 * dead too, the boot-failed screen is already up).
 */
const HEALED_AT_KEY = "wingover.idbHealedAt";
const COUNT_KEY = "wingover.idbHealCount";
const TERMINAL_WINDOW_MS = 10 * 60_000;
const TERMINAL_COUNT = 2;
const MIN_UPTIME_MS = 15_000;
const PROBE_TIMEOUT_MS = 5_000;

const bootedAt = Date.now();

// The severed signatures and the PouchDB unwrap live in
// storage/idbErrors, shared with db.ts's swap classifier; re-exported
// here for the drills.
export { describeRejection, SEVERED_IDB } from "../../storage/idbErrors";

/** Pure, for the drills: the terminal count over a persisted "start:count". */
export function nextCount(
  raw: string | null,
  now: number,
): { allowed: boolean; next: string } {
  const [startRaw, countRaw] = (raw ?? "").split(":");
  const start = Number(startRaw);
  const count = Number(countRaw);
  const inWindow =
    Number.isFinite(start) &&
    Number.isFinite(count) &&
    now - start < TERMINAL_WINDOW_MS;
  if (!inWindow) return { allowed: true, next: `${now}:1` };
  if (count >= TERMINAL_COUNT) return { allowed: false, next: raw ?? "" };
  return { allowed: true, next: `${start}:${count + 1}` };
}

function probeIdb(): Promise<void> {
  return new Promise((resolve, reject) => {
    // A hung open (the WebKit no-event class) is NO VERDICT, never a heal:
    // resolve on timeout so a silent instrument cannot read as healthy
    // failure.
    const timer = setTimeout(resolve, PROBE_TIMEOUT_MS);
    const request = indexedDB.open("wingover-idb-probe");
    request.onsuccess = () => {
      clearTimeout(timer);
      request.result.close();
      resolve();
    };
    request.onerror = () => {
      clearTimeout(timer);
      reject(request.error ?? new Error("idb probe failed"));
    };
  });
}

function heal(reason: unknown) {
  // Uptime first: this bound holds even when localStorage is as dead as
  // the storage it fronts (WebKit serves both from one connection).
  if (Date.now() - bootedAt < MIN_UPTIME_MS) return;
  try {
    const verdict = nextCount(localStorage.getItem(COUNT_KEY), Date.now());
    if (!verdict.allowed) return;
    localStorage.setItem(COUNT_KEY, verdict.next);
  } catch {
    return;
  }
  if (!takeHeal(HEALED_AT_KEY)) return;
  console.error("IndexedDB severed; healing with one reload:", reason);
  window.location.reload();
}

function healIfSevered(reason: unknown) {
  const text = describeRejection(reason);
  const severed =
    SEVERED_IDB.test(text) ||
    (reason instanceof Error && reason.name === "UnknownError");
  if (severed) heal(reason);
}

let probing = false;

function probeAndHeal() {
  if (probing) return;
  probing = true;
  probeIdb()
    .catch(healIfSevered)
    .finally(() => {
      probing = false;
    });
}

/**
 * Called once at app entry, native only (see the header).
 */
export function initIdbHeal() {
  if (!isTauri()) return;
  // Proactive: the observed sequence is install-while-backgrounded, so
  // the first foreground probes the storage server.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    probeAndHeal();
  });
  // In flight the shell is shed and the engine absorbs every WAL
  // rejection into STORAGE_ERROR (enqueueWal) — nothing ever goes
  // unhandled there. The engine's public error surface is therefore the
  // only in-flight signal; a storage error triggers a probe, and the
  // probe's discrimination decides.
  engine.subscribe(() => {
    if (engine.snapshotSync().error?.code === "storage") probeAndHeal();
  });
  // Reactive, for the ground app's direct consumers (PouchDB reads): a
  // severed-looking rejection is a SUSPICION, not a verdict — a logout
  // destroying the instance mid-read produces the same text. The probe
  // is the verdict: during a logout it succeeds (the storage server is
  // fine) and nothing heals; in a severed session it fails too, and its
  // own failure is what heals. Every trigger converges on the one
  // instrument.
  window.addEventListener("unhandledrejection", (event) => {
    if (SEVERED_IDB.test(describeRejection(event.reason))) probeAndHeal();
  });
}
