import { useEffect, useState } from "react";

import {
  getSetting,
  onSettingChanged,
  setSetting,
} from "../../../storage/local";
import type { MapViewKind } from "../../shared/map/config";

/**
 * The street/satellite choice is ONE app-level, persistent toggle: flip it
 * on any ground map and every ground map follows, immediately (tab pages
 * stay mounted forever, so this rides the settings store's same-session
 * events) and across relaunches. It also drives the app palette — see
 * appTheme.ts. The FLIGHT surface deliberately does not participate: its
 * view lives in liveViewState, chosen for flying, not browsing.
 */
const KINDS: MapViewKind[] = ["street", "satellite", "chart"];

const isKind = (value: string | null): value is MapViewKind =>
  KINDS.includes(value as MapViewKind);

export default function useMapView(): [
  MapViewKind,
  (view: MapViewKind) => void,
] {
  const [view, setView] = useState<MapViewKind>("street");

  useEffect(() => {
    let alive = true;
    void getSetting("mapView").then((value) => {
      if (alive && isKind(value)) setView(value);
    });
    const off = onSettingChanged("mapView", (value) => {
      if (isKind(value)) setView(value);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  function changeView(value: MapViewKind) {
    setView(value);
    void setSetting("mapView", value);
  }

  return [view, changeView];
}
