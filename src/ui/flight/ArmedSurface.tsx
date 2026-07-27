import type { EngineErrorCode, Fix } from "../../engine/types";
import { formatAltitude, formatSpeed } from "../../flight/format";
import type { Units } from "../../flight/format";
import { isTauri } from "../../platform";
import { cx } from "../cx";

import styles from "./FlightSurface.module.css";

// Locking the phone is only safe where the native layer records through
// it (background location); the PWA is foreground-only.
const ACQUIRING_HINT = isTauri()
  ? "Make sure you're in an open, unobstructed area. It's safe to lock your phone."
  : "Make sure you're in an open, unobstructed area.";

const ARMED_HINT = isTauri()
  ? "Recording starts automatically when you launch. It's safe to lock your phone."
  : "Recording starts automatically when you launch.";

/**
 * The two pre-takeoff states, which differ only in what they are waiting
 * for: a first usable fix ("acquiring", showing accuracy) or the launch
 * itself ("armed", showing ground speed).
 */
export default function ArmedSurface({
  status,
  latest,
  units,
  errorCode,
  onCancel,
}: {
  status: "acquiring" | "armed";
  latest: Fix | null;
  units: Units;
  errorCode: EngineErrorCode | undefined;
  onCancel: () => void;
}) {
  const acquiring = status === "acquiring";

  function hint() {
    if (!acquiring) return ARMED_HINT;
    // A dead GPS (Location Services off system-wide) is as actionable as
    // a permission problem; the diagnostic replaces the generic hint
    // rather than sitting mute in the snapshot.
    if (errorCode === "unavailable") {
      return "GPS unavailable. Check that Location Services are on.";
    }
    return ACQUIRING_HINT;
  }

  function accuracy() {
    if (!latest) return "—";
    return `±${formatAltitude(latest.horizontalAccuracy, units)} H · ±${formatAltitude(latest.verticalAccuracy, units)} V`;
  }

  function readout() {
    if (acquiring) {
      return (
        <div className={styles.armedAccuracy} data-testid="armed-accuracy">
          {accuracy()}
        </div>
      );
    }
    return (
      <div className={styles.armedSpeed} data-testid="armed-speed">
        {latest ? formatSpeed(latest.speed, units) : "—"}
      </div>
    );
  }

  return (
    <div className={styles.armed} data-testid="armed">
      <div className={styles.armedMessage}>
        <div
          className={cx(styles.pulse, acquiring && styles.acquiring)}
          aria-hidden="true"
        />
        <h2>{acquiring ? "Acquiring GPS" : "Waiting for takeoff"}</h2>
        <p>{hint()}</p>
      </div>
      {readout()}
      <button className={styles.cancel} onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
