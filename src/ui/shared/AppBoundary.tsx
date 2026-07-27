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

function lastHealedAt(): number | null {
  try {
    const raw = localStorage.getItem(HEALED_AT_KEY);
    if (raw === null) return null;
    const at = Number(raw);
    return Number.isFinite(at) ? at : null;
  } catch {
    // No store, or it threw. Treat it as "never healed": one reload attempt is
    // the safer failure, since the alternative is a crash screen mid-flight.
    return null;
  }
}

function heal() {
  const now = Date.now();
  if (!mayHeal(now, lastHealedAt())) return;
  try {
    // Written BEFORE the reload, or the next crash cannot see it.
    localStorage.setItem(HEALED_AT_KEY, String(now));
  } catch {
    // An unwritable store means the window cannot be enforced across the
    // reload, so do not reload at all: a loop is worse than a crash screen.
    return;
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
  return (
    <ErrorBoundary
      FallbackComponent={AppCrash}
      onError={attemptHeal ? heal : undefined}
    >
      {children}
    </ErrorBoundary>
  );
}
