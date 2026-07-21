import { useEffect, useEffectEvent, useRef } from "react";

import type { Fix } from "../../engine/types";
import type { Aircraft, MapView } from "../map/types";

/**
 * Drives the HOST map's aircraft glyph from the replay feed: the dot that
 * flies the already-drawn track. Owns nothing else — the host's track
 * line, markers, and camera stay exactly as the host renders them, so
 * replay is a layer on the map the pilot is already looking at, not a
 * separate surface.
 */
export function useReplayMapDriver(map: MapView | null, latest: Fix | null) {
  const aircraftRef = useRef<Aircraft | null>(null);

  const place = useEffectEvent(() => {
    if (!latest) return;
    aircraftRef.current?.set({
      at: [latest.longitude, latest.latitude],
      heading: latest.course,
    });
  });

  useEffect(() => {
    if (!map) return;
    const aircraft = map.aircraft();
    aircraftRef.current = aircraft;
    place();
    return () => {
      aircraftRef.current = null;
      // A provider swap destroys the view before the null onReady lands
      // here; removing a handle from a dead view must not throw the app.
      try {
        aircraft.remove();
      } catch {
        // nothing left to clean on a destroyed view
      }
    };
  }, [map]);

  useEffect(() => {
    place();
  }, [latest]);
}
