import { useEffect, useState } from "react";

import { getSetting, setSetting } from "../../storage/local";
import type { MapViewKind } from "./config";
import { readLiveViewState, writeLiveViewState } from "./liveViewState";

interface LiveViewPrefs {
  mapView: MapViewKind;
  follow: boolean;
  trackUp: boolean;
}

/**
 * The live map's three persisted preferences as one piece of state, with
 * updates written through to liveViewState (and mapView to settings, so
 * the ground maps follow the same street/satellite choice).
 */
export function useLiveViewPrefs(): LiveViewPrefs & {
  update: (patch: Partial<LiveViewPrefs>) => void;
} {
  const [prefs, setPrefs] = useState<LiveViewPrefs>(() => {
    const saved = readLiveViewState();
    return {
      mapView: saved.mapView ?? "street",
      follow: saved.follow ?? true,
      trackUp: saved.trackUp ?? false,
    };
  });

  // The ground maps' street/satellite choice (a setting) seeds the live
  // map too; liveViewState is the tiebreak until the async read lands.
  useEffect(() => {
    void getSetting("mapView").then((value) => {
      if (value === "street" || value === "satellite") {
        setPrefs((current) =>
          current.mapView === value ? current : { ...current, mapView: value },
        );
      }
    });
  }, []);

  function update(patch: Partial<LiveViewPrefs>) {
    setPrefs((current) => ({ ...current, ...patch }));
    writeLiveViewState(patch);
    if (patch.mapView) void setSetting("mapView", patch.mapView);
  }

  return { ...prefs, update };
}
