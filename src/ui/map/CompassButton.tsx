import { useSyncExternalStore } from "react";

import { cx } from "../cx";
import type { MapView } from "./types";

import styles from "./CompassButton.module.css";
import mapCss from "./map.module.css";

// Off north by less than this and the compass doesn't exist — an invisible
// rotation shouldn't summon a button.
const SHOW_DEG = 1;

// Signed smallest angle from north, in (-180, 180].
function offNorth(bearing: number) {
  return ((((bearing + 180) % 360) + 360) % 360) - 180;
}

interface CompassButtonProps {
  map: MapView;
}

// The ground-map compass: rotation gestures are enabled on every backend, so
// when the map is off north this appears in the overlay stack, its needle
// tracking the live bearing (red half at true north). A tap eases back to
// north-up, which hides it again. The live flight map has its own track-up
// control and never renders this.
export default function CompassButton({ map }: CompassButtonProps) {
  // The map is an external store: subscribe to its rotate stream, snapshot
  // the camera bearing.
  const bearing = useSyncExternalStore(
    (notify: () => void) => map.on("rotate", notify),
    () => map.camera().bearing,
  );

  if (Math.abs(offNorth(bearing)) < SHOW_DEG) return null;

  return (
    <button
      className={cx(mapCss.button, styles.compass)}
      aria-label="Point north"
      data-testid="map-compass"
      onClick={() => map.moveTo({ bearing: 0 }, { animate: true })}
    >
      <svg
        viewBox="-12 -12 24 24"
        width="26"
        height="26"
        aria-hidden="true"
        style={{ transform: `rotate(${-bearing}deg)` }}
      >
        <polygon className={styles.north} points="0,-11 3.2,0 -3.2,0" />
        <polygon className={styles.south} points="0,11 3.2,0 -3.2,0" />
      </svg>
    </button>
  );
}
