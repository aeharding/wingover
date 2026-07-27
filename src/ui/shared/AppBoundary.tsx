import { type ReactNode, useLayoutEffect } from "react";
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
 * Takes this page-load's one heal, or returns false. Called in exactly one
 * place, by the fallback, so the decision is made once and nothing re-checks.
 *
 * Claiming means WRITING the marker, not just reading it, and the reload below
 * is conditional on that write. An earlier version reloaded even when the
 * write threw, reasoning that nothing was on screen to fall back to. On a full
 * disk — `setItem` throws, `getItem` keeps returning null — that never
 * enforces the window: measured at 101 navigations in 12 seconds, a hard
 * reload every 90 ms during an active recording. A crash screen is always
 * better than that.
 *
 * The write happens during render, which is impure, and the failure that buys
 * is benign in the only direction it can fail: a render React discards after
 * the claim spends the window without reloading, so the next crash shows the
 * crash screen instead of healing. Never a loop, never a blank page.
 */
function claimHeal(): boolean {
  try {
    const raw = localStorage.getItem(HEALED_AT_KEY);
    const at = raw === null ? null : Number(raw);
    if (!mayHeal(Date.now(), at !== null && Number.isFinite(at) ? at : null)) {
      return false;
    }
    // Written BEFORE the reload, or the next crash cannot see it.
    localStorage.setItem(HEALED_AT_KEY, String(Date.now()));
    return true;
  } catch {
    // Unusable store: the window cannot be enforced across a reload, so there
    // is no safe reload to offer.
    return false;
  }
}

/**
 * Renders nothing and reloads, which is what a heal looks like: the crash
 * screen must not paint for the frame before the page goes away. The heal was
 * already claimed by the fallback that rendered this.
 *
 * A LAYOUT effect, not a passive one. Passive effects are what React defers
 * under main-thread pressure, and until it runs this shows nothing — #185's
 * own report is "app black for 5 to 10 seconds", so a deferred reload would
 * recreate the symptom it is curing.
 */
function Healing() {
  useLayoutEffect(onUnrecoverableAppError, []);
  return null;
}

/**
 * Named for the situation, not the mechanism, and deliberately not exported.
 * A shared `reloadPage()` would be a bypass: anything could import it and
 * reload without the ban ever being reviewed.
 */
function onUnrecoverableAppError() {
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
    if (attemptHeal && claimHeal()) return <Healing />;
    return <AppCrash />;
  }

  return <ErrorBoundary fallbackRender={fallback}>{children}</ErrorBoundary>;
}
