import { isTauri } from "../../platform/index";

/**
 * The severed-IndexedDB heal (Voyager's pattern, observed 2026-07-30 on
 * device): replacing the app bundle under a RUNNING webview severs every
 * IndexedDB connection. Reads then fail with "the database connection is
 * closing" or "Connection to Indexed Database server lost", the logbook
 * reads as empty, the WAL cannot hydrate, and sync cannot connect — while
 * every byte on disk is fine. Only a fresh page fixes it, so this is a
 * SANCTIONED location.reload (eslint.config.js ignore list): the page is
 * already broken in a way no instance swap can reach, because the broken
 * thing is the process's connection to storage itself.
 *
 * One reload per cooldown window, stamped in localStorage so the stamp
 * survives the reload. If storage is still dead on the reloaded boot, the
 * WAL read rejects, hydration lands on "failed", and the boot-failed
 * screen takes over — that is the escalation, and it already exists.
 */
const HEALED_AT_KEY = "wingover.idbHealedAt";
const COOLDOWN_MS = 60_000;

// Both spellings WebKit uses for a severed session, either name or message.
export const SEVERED_IDB =
  /database connection is closing|Indexed Database server lost/i;

/** Pure, for the drill: heal at most once per window. */
export function shouldHeal(lastHealedAt: number, now: number): boolean {
  return now - lastHealedAt >= COOLDOWN_MS;
}

function probeIdb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("wingover-idb-probe");
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => {
      reject(request.error ?? new Error("idb probe failed"));
    };
  });
}

function heal(reason: unknown) {
  const last = Number(localStorage.getItem(HEALED_AT_KEY) ?? 0);
  if (!shouldHeal(last, Date.now())) return;
  localStorage.setItem(HEALED_AT_KEY, String(Date.now()));
  console.error("IndexedDB severed; healing with one reload:", reason);
  window.location.reload();
}

function describeRejection(reason: unknown): string {
  if (reason instanceof Error) return `${reason.name}: ${reason.message}`;
  return String(reason);
}

/**
 * Called once at app entry. Native only: the severed state comes from the
 * bundle being swapped under a live process (dev installs, App Store
 * updates), which the plain web build has no equivalent of.
 */
export function initIdbHeal() {
  if (!isTauri()) return;
  // Proactive: the common sequence is install-while-backgrounded, so the
  // first foreground probes the storage server and heals before the pilot
  // finds an empty logbook.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    probeIdb().catch(heal);
  });
  // Reactive: a severed connection discovered mid-session by any consumer
  // (PouchDB, the WAL, sync) surfaces as an unhandled rejection.
  window.addEventListener("unhandledrejection", (event) => {
    if (SEVERED_IDB.test(describeRejection(event.reason))) heal(event.reason);
  });
}
