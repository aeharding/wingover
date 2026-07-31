import { type ReactNode, useLayoutEffect } from "react";
import { ErrorBoundary } from "react-error-boundary";

import AppCrash from "./AppCrash";
import { takeHeal } from "./healBudget";

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

/**
 * Takes this page-load's one heal, or returns false. Called in exactly one
 * place, by the fallback, so the decision is made once and nothing
 * re-checks. The window policy and the full-disk refusal live in
 * healBudget, shared with idbHeal.
 */
let claimed: boolean | null = null;

function claimHeal(): boolean {
  // Decided ONCE per page load. React 19 renders a pass that threw, discards
  // it, then renders again from the root — so an un-memoised compare-and-set
  // answers `true` to the render that is thrown away and `false` to the one
  // that commits, and the heal never happens at all. That is not a hazard, it
  // is measured: three harnesses, production React included, all showed
  // AppCrash committing and reload() never called.
  //
  // A page-load memo is the right lifetime because a reload is what clears it.
  claimed ??= takeHeal(HEALED_AT_KEY);
  return claimed;
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
  try {
    window.location.reload();
  } catch {
    // A throw here lands in the fallback's own subtree, which no boundary can
    // catch, and unmounts the root: rootChildren 0, i.e. the #185 signature
    // this file exists to prevent. reload() can throw SecurityError in a
    // sandboxed context. Swallowing leaves the pilot on a blank frame, but the
    // crash screen is one render away rather than gone.
  }
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
