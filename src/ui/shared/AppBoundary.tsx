import type { ReactNode } from "react";
import { ErrorBoundary } from "react-error-boundary";

import AppCrash from "./AppCrash";

/**
 * The app's only error boundary. Without one, a throw during render or commit
 * unmounts the root and the pilot gets a black screen with no way out — which
 * is what #185 did, via commitLayoutEffectOnFiber -> defaultOnUncaughtError ->
 * rootChildren: 0.
 *
 * One prop decides the whole policy, and PLACEMENT decides the prop:
 *
 *   attemptHeal   reload the page once, then show the crash screen if it
 *                 breaks again inside the window. App.tsx wraps the flight
 *                 surface with this.
 *   (no prop)     never reload; show the crash screen. App.tsx wraps the
 *                 ground shell with this.
 *
 * Placement is not an approximation of "is a flight in progress" — it is
 * exactly equivalent, because App.tsx sheds the entire Ionic shell for the
 * flight surface the moment the engine leaves "idle". The two are never both
 * mounted.
 *
 * A reload is the strongest recovery available and, mid-flight, close to
 * invisible: recording is engine-side and WAL-backed, and boot re-hydrates it
 * (src/engine/session.ts). It is also what un-poisoned the corrupted MapKit
 * map in #185, so there is no cleverer per-subtree repair worth having.
 */

const HEALED_AT_KEY = "wingover.crash.healedAt";
const HEAL_WINDOW_MS = 60_000;

/**
 * The entire heal policy, pure so it can be tested without a DOM or a reload.
 *
 * The marker has to be PERSISTED, not held in a variable: the reload destroys
 * every value in the page, so an in-memory counter cannot enforce "once per
 * 60 s" and the result is an unbounded reload loop.
 */
export function mayHeal(now: number, healedAt: number | null): boolean {
  if (healedAt === null) return true;
  return now - healedAt >= HEAL_WINDOW_MS;
}

/**
 * Whether a reload is about to happen. Read by BOTH the fallback render and
 * the error handler, and it must give them the same answer: the fallback runs
 * first and paints nothing when a heal is coming, so a handler that then
 * declined would leave a blank page forever.
 *
 * That is why an unusable store answers "no" rather than "never healed" — the
 * two paths agreeing matters more than getting one extra reload attempt out of
 * a browser whose storage is broken.
 */
function healableNow(): boolean {
  try {
    const raw = localStorage.getItem(HEALED_AT_KEY);
    if (raw === null) return true;
    const at = Number(raw);
    return mayHeal(Date.now(), Number.isFinite(at) ? at : null);
  } catch {
    return false;
  }
}

/**
 * Named for the situation, not the mechanism, and deliberately not exported.
 * A shared `reloadPage()` would be a bypass: anything could import it and
 * reload without the ban ever being reviewed. Reloading is only defensible
 * from inside this one decision.
 */
function onUnrecoverableAppError() {
  if (!healableNow()) return;
  try {
    // Written BEFORE the reload, or the next crash cannot see it.
    localStorage.setItem(HEALED_AT_KEY, String(Date.now()));
  } catch {
    // Reload anyway. The fallback has already painted nothing on the strength
    // of healableNow(), so bailing out here would leave a blank page forever,
    // which is the exact bug this whole file exists to prevent. A reload whose
    // window could not be recorded is the lesser failure, and it needs the
    // store to fail between a successful read and a write to happen at all.
  }
  window.location.reload();
}

export default function AppBoundary({
  attemptHeal,
  children,
}: {
  attemptHeal?: boolean;
  children: ReactNode;
}) {
  function fallback() {
    // Paint NOTHING when a reload is coming. The fallback renders one commit
    // before onError runs, so drawing the crash screen here flashes it red for
    // a frame and then reloads — observed on device. Blank for that frame
    // reads as the reload it is.
    if (attemptHeal && healableNow()) return null;
    // Otherwise the same flag that decides whether to heal decides what the
    // screen may promise: only a flight in progress is still being recorded,
    // and claiming that on the ground would be a lie.
    return <AppCrash inFlight={attemptHeal === true} />;
  }

  return (
    <ErrorBoundary
      fallbackRender={fallback}
      onError={attemptHeal ? onUnrecoverableAppError : undefined}
    >
      {children}
    </ErrorBoundary>
  );
}
