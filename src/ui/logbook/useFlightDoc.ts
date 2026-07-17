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
 * One flight and its track, keyed by id. The stored value remembers WHICH
 * id it belongs to and the return is derived from that match, so a
 * persistent consumer (the desktop seat) shows nothing of flight A while
 * flight B loads — no clear-state effect needed.
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
    flight: current?.flight ?? null,
    track: current?.track ?? [],
    setFlight: (flight) =>
      setLoaded((prior) => (prior?.id === id ? { ...prior, flight } : prior)),
  };
}
