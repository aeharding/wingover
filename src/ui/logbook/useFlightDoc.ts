import { useEffect, useState } from "react";

import type { Fix } from "../../engine/types";
import {
  type Flight,
  getFlight,
  getTrack,
  onDocsChanged,
} from "../../storage/db";

interface Loaded {
  id: string;
  flight: Flight | null;
  track: Fix[];
}

/**
 * One flight and its track, keyed by id. The TRACK is id-gated: while
 * flight B loads, the map shows nothing of flight A (a mislabeled line is
 * worse than a blank beat). The FLIGHT doc is held through the gap: the
 * seat's card stays mounted and swaps content instead of flickering out
 * and back per selection — the gap is a local read, tens of ms, and no
 * interaction can land inside it (blur commits before the click).
 */
export function useFlightDoc(id: string): {
  flight: Flight | null;
  setFlight: (flight: Flight) => void;
  track: Fix[];
} {
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([getFlight(id), getTrack(id)]).then(([flight, track]) => {
      if (!cancelled) setLoaded({ id, flight, track });
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // A persistent consumer (the desktop seat) must see remote edits: a
  // rename replicated in from another device updates the doc under us.
  // In-progress local drafts are keyed to the old object and re-derive —
  // the remote write wins, which beats silently clobbering it on blur.
  useEffect(
    () =>
      onDocsChanged("flight", () => {
        void getFlight(id).then((flight) => {
          setLoaded((prior) =>
            prior?.id === id ? { ...prior, flight } : prior,
          );
        });
      }),
    [id],
  );

  const current = loaded?.id === id ? loaded : null;
  return {
    flight: current?.flight ?? loaded?.flight ?? null,
    track: current?.track ?? [],
    setFlight: (flight) =>
      setLoaded((prior) => (prior?.id === id ? { ...prior, flight } : prior)),
  };
}
