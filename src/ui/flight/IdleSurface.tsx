import { useEffect, useState } from "react";

import { formatDistance } from "../../flight/format";
import type { Units } from "../../flight/format";
import { haversineMeters } from "../../flight/stats";
import { sunFactLabel } from "../../flight/sun";
import type { Flight, Pin } from "../../storage/db";

import styles from "./FlyPage.module.css";

/**
 * The pre-flight screen: a couple of quiet facts and one enormous button.
 *
 * Idle facts are all derived offline (tiles stay the app's entire network
 * surface). The sun fact needs a location: the last flight's launch, else
 * the first planned pin — where they last flew or where they're planning
 * is where a pilot flies next. No location, no line.
 */
export default function IdleSurface({
  units,
  plannedPins,
  lastFlight,
  onStart,
}: {
  units: Units;
  plannedPins: Pin[];
  lastFlight: Flight | null;
  onStart: () => void;
}) {
  // The sun fact is relative time through most of the cycle; re-render
  // by the minute while this surface is up so it cannot go stale on a
  // propped phone.
  useMinuteTick();

  const sunFact = sunFactFor(lastFlight, plannedPins);
  const plannedRouteMeters = routeMeters(plannedPins);
  const hasPlannedRoute = plannedRouteMeters > 0;

  return (
    <div className={styles.idle}>
      <div className={styles.facts} data-testid="idle-facts">
        {sunFact && <div>{sunFact}</div>}
        {hasPlannedRoute && (
          <div data-testid="planned-route">
            Planned route: {formatDistance(plannedRouteMeters, units)}
          </div>
        )}
      </div>
      <button className={styles.start} onClick={onStart}>
        Start Flight
      </button>
    </div>
  );
}

function sunFactFor(lastFlight: Flight | null, plannedPins: Pin[]) {
  const launch = lastFlight?.launchAt;
  if (launch) return sunFactLabel(new Date(), launch[1], launch[0]);
  const pin = plannedPins[0];
  if (!pin) return null;
  return sunFactLabel(new Date(), pin.latitude, pin.longitude);
}

/** Total planned-route length = sum of the legs between consecutive pins. */
function routeMeters(pins: Pin[]): number {
  let total = 0;
  for (let i = 1; i < pins.length; i++) {
    total += haversineMeters(pins[i - 1], pins[i]);
  }
  return total;
}

// A render heartbeat for the relative sun fact, only while it shows.
function useMinuteTick() {
  const [, bump] = useState(0);
  useEffect(() => {
    const id = setInterval(() => bump((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);
}
