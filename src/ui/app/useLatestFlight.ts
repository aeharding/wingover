import { useSyncExternalStore } from "react";

import { type Flight, listFlights, onDocsChanged } from "../../storage/db";

// A module-level store, not per-hook state: the idle screen has TWO
// consumers of the newest flight (the surface's facts and the frame's
// FlyTrace backdrop), and per-component hooks meant two full listFlights
// scans plus two change-feed subscriptions for the same document. One
// feed, one scan, shared snapshot. Decorative consumers only — failures
// just leave the snapshot null.
let latest: Flight | null = null;
let feedStarted = false;
const listeners = new Set<() => void>();

function reload() {
  void listFlights()
    .then((flights) => {
      latest = flights[0] ?? null;
      listeners.forEach((notify) => notify());
    })
    .catch(() => {});
}

function subscribe(listener: () => void): () => void {
  if (!feedStarted) {
    // Started once, never torn down: onDocsChanged's feed outlives any
    // one consumer, and the idle screen remounts on every flight.
    feedStarted = true;
    reload();
    onDocsChanged("flight", reload);
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => latest;

/**
 * The pilot's newest logbook flight, live: landing a flight, deleting
 * one, or a synced pull re-picks it in place for every subscriber.
 */
export function useLatestFlight(): Flight | null {
  return useSyncExternalStore(subscribe, snapshot);
}
