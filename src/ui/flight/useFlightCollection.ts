import { useEffect, useEffectEvent } from "react";

import { engine } from "../../engine";
import type { EngineStatus, Fix, LngLat, Waypoint } from "../../engine/types";
import { computeStats } from "../../flight/stats";
import { inheritedLaunchName, saveFlight } from "../../storage/db";
import { showToast } from "./toast";

async function persistFlight(flown: Fix[], plannedWaypoints: Waypoint[]) {
  if (flown.length <= 1) return;
  const startedAt = flown[0].timestamp;
  // The planned pins ([lng, lat], in order) so the flight detail map can
  // draw the grey optimal-path line alongside the flown track.
  const plannedRoute: LngLat[] = plannedWaypoints.map((w) => [
    w.longitude,
    w.latitude,
  ]);
  const launchAt: LngLat = [flown[0].longitude, flown[0].latitude];
  // The label is decorative; the save is sacred. A failed logbook read
  // must never block persisting the flight (STEERING: no recoverable
  // failure loses track data) — an error here just means no name today.
  const launchName = await inheritedLaunchName(launchAt).catch(() => undefined);
  try {
    await saveFlight(
      {
        // Deterministic id: re-running collection after a crash between
        // save and WAL-clear must not duplicate the flight.
        id: `recorded-${startedAt}`,
        // No minted name: a display default baked into storage reads as
        // something the pilot typed, and every surface then needs
        // string-matching to un-bake it. Empty means "untitled"; the UI
        // falls back launch site, then date (flightTitle).
        name: "",
        notes: "",
        startedAt,
        stats: computeStats(flown),
        updatedAt: Date.now(),
        launchAt,
        launchName,
        ...(plannedRoute.length > 0 ? { plannedRoute } : {}),
      },
      flown,
    );
  } catch (error) {
    if ((error as { name?: string }).name !== "conflict") throw error;
  }
  // Body-level and imperative (see toast.ts): it survives this
  // component unmounting the instant the flight ends and the nav shell
  // swaps back in.
  showToast("Flight saved to logbook");
}

/**
 * Collection: the finalized flight goes to the logbook, then out of the
 * engine's durable hands.
 *
 * Blocked recovery (foreground retry + the native refusal loop) is wired
 * engine-side in src/engine/session.ts, not here: it must run regardless
 * of which page is mounted (docs/ENGINE-AUDIT.md asks exactly this of any
 * new component effect). Collection may live view-side because that
 * question has a mechanical answer here: src/ui/App.tsx sheds the shell
 * for anything that is not "idle", and "ended" is not "idle" — so this
 * surface, and nothing else, is mounted for the whole collection window.
 * There is no other page to be in. If that predicate is ever narrowed,
 * this has to move engine-side with it.
 */
export function useFlightCollection(status: EngineStatus | "loading") {
  // "ended" is a durable state: the finalized flight waits in the WAL.
  // Persist first, discard after — a crash in between just repeats this
  // on next launch, and the deterministic flight id makes it idempotent.
  const collectEndedFlight = useEffectEvent(async () => {
    const snapshot = await engine.getSnapshot();
    if (snapshot.status !== "ended") return;
    try {
      await persistFlight(snapshot.track, snapshot.waypoints);
    } catch (error) {
      // The one storage failure that is genuinely possession-losing —
      // surface loudly (STEERING). The WAL keeps the flight; collection
      // retries on the next mount/foreground.
      console.error("flight persist failed:", error);
      showToast("Could not save the flight yet. It is safe; will retry.");
      return;
    }
    // Persisted — the engine's durable copy can go; idle follows.
    await engine.discard();
  });

  // A flight that ended — now, or while the app was away (durable "ended"
  // hydrated from the WAL) — is collected the moment the view sees it.
  // Deferred a tick: collection drives the engine (persist, stop), it does
  // not synchronize render state.
  useEffect(() => {
    if (status !== "ended") return;
    void Promise.resolve().then(() => collectEndedFlight());
  }, [status]);
}
