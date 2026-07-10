import { IonIcon } from "@ionic/react";
import { globeOutline, mapOutline } from "ionicons/icons";

import type { MapViewKind } from "./config";

interface ViewToggleProps {
  view: MapViewKind;
  onChange: (view: MapViewKind) => void;
}

export default function ViewToggle({ view, onChange }: ViewToggleProps) {
  const next: MapViewKind = view === "street" ? "satellite" : "street";
  return (
    <button
      className="map-button"
      aria-label={next === "satellite" ? "Satellite view" : "Street view"}
      onClick={() => onChange(next)}
    >
      <IonIcon icon={next === "satellite" ? globeOutline : mapOutline} />
    </button>
  );
}
