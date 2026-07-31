import { isTauri } from "../../platform/index";
import { describeRejection, SEVERED_IDB } from "../../storage/idbErrors";
import { takeHeal } from "./healBudget";

/**
 * The severed-IndexedDB heal, Voyager's field-proven shape (observed here
 * 2026-07-30: a dev install replacing the bundle under a running webview
 * severed every IndexedDB connection — empty logbook, no hydration, sync
 * dead, every byte on disk fine). On each return to foreground, probe the
 * storage server with a throwaway open; only a severed-signature failure
 * heals, with ONE reload per window (healBudget, shared mechanism with
 * AppBoundary's crash heal, its own key).
 *
 * The foreground is the only trigger, deliberately: a reload gated on a
 * human returning to the app cannot loop by itself, which is the whole
 * bounding story. Storage dead at boot lands on the boot-failed screen by
 * the existing hydration path.
 *
 * Native only, and the gate is load-bearing SAFETY: on the PWA the WAL is
 * the only copy of an in-progress flight. On iOS the Rust store replays
 * fixes from its durable queue after any reload. This is a SANCTIONED
 * location.reload (eslint.config.js ignore list): the broken thing is the
 * process's connection to storage itself, which no instance swap reaches.
 */
const HEALED_AT_KEY = "wingover.idbHealedAt";

export { describeRejection, SEVERED_IDB } from "../../storage/idbErrors";

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

function healIfSevered(reason: unknown) {
  // A quota or transient failure must never reload; only the severed
  // signatures (or WebKit's UnknownError on the fresh open) count.
  const text = describeRejection(reason);
  const severed =
    SEVERED_IDB.test(text) ||
    (reason instanceof Error && reason.name === "UnknownError");
  if (!severed) return;
  if (!takeHeal(HEALED_AT_KEY)) return;
  console.error("IndexedDB severed; healing with one reload:", reason);
  window.location.reload();
}

/** Called once at app entry, native only (see the header). */
export function initIdbHeal() {
  if (!isTauri()) return;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    probeIdb().catch(healIfSevered);
  });
}
