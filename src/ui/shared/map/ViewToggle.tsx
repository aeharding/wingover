import { airplaneOutline, globeOutline, mapOutline } from "ionicons/icons";

import NativeIcon from "../components/NativeIcon";
import type { MapViewKind } from "./config";

import mapCss from "./map.module.css";

interface ViewToggleProps {
  view: MapViewKind;
  // The cycle this map offers, in press order. Callers decide what is on
  // it: ground maps may include "chart" (useGroundMapViews), the flight
  // surface never does.
  views: MapViewKind[];
  onChange: (view: MapViewKind) => void;
}

const LABEL: Record<MapViewKind, string> = {
  street: "Street view",
  satellite: "Satellite view",
  chart: "Sectional chart view",
};

const ICON: Record<MapViewKind, string> = {
  street: mapOutline,
  satellite: globeOutline,
  chart: airplaneOutline,
};

export default function ViewToggle({ view, views, onChange }: ViewToggleProps) {
  // A view that is not on the cycle — a stored "chart" on a device that
  // has since lost charts — indexes to -1, so the next press lands on the
  // first view rather than nowhere.
  const next = views[(views.indexOf(view) + 1) % views.length];
  return (
    <button
      className={mapCss.button}
      aria-label={LABEL[next]}
      onClick={() => onChange(next)}
    >
      <NativeIcon icon={ICON[next]} />
    </button>
  );
}
