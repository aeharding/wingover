import { type ReactNode, useEffect } from "react";
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
 * Whether a reload is allowed right now. Read in exactly one place, by the
 * fallback: once it decides, nothing re-checks.
 *
 * An unusable store answers "no" rather than "never healed". Without a marker
 * the once-per-60s window cannot be enforced across the reload, and an
 * unbounded reload loop is worse than a crash screen.
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
 * Renders nothing and reloads, which is what a heal looks like: the crash
 * screen must not paint for the frame before the page goes away.
 *
 * The decision was already made by the fallback that rendered this. Nothing
 * here re-checks it, deliberately — two `Date.now()` reads can straddle the
 * window edge, and a second check that came back "no" after the fallback had
 * already committed to painting nothing would leave a blank page forever,
 * which is the exact bug this file exists to prevent.
 */
function Healing() {
  useEffect(onUnrecoverableAppError, []);
  return null;
}

/**
 * Named for the situation, not the mechanism, and deliberately not exported.
 * A shared `reloadPage()` would be a bypass: anything could import it and
 * reload without the ban ever being reviewed. Reloading is only defensible
 * from inside this one decision.
 */
function onUnrecoverableAppError() {
  try {
    // Written BEFORE the reload, or the next crash cannot see it.
    localStorage.setItem(HEALED_AT_KEY, String(Date.now()));
  } catch {
    // Reload anyway: nothing is on screen to fall back to.
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
  // The one place the heal is decided. It has to be here rather than in an
  // onError handler: the fallback renders a commit EARLIER, so deciding later
  // means the crash screen paints red for a frame and then reloads (observed
  // on device), and deciding in both means two Date.now() reads that can
  // disagree at the window edge.
  function fallback() {
    if (attemptHeal && healableNow()) return <Healing />;
    // Not healing, so the screen is what the pilot is left with. The same flag
    // decides what it may promise: only a flight in progress is still being
    // recorded, and claiming that on the ground would be a lie.
    return <AppCrash inFlight={attemptHeal === true} />;
  }

  return <ErrorBoundary fallbackRender={fallback}>{children}</ErrorBoundary>;
}
