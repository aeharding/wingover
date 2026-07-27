import { useEffect, useState } from "react";

import { startFlight } from "../../engine/session";
import { formatDistance } from "../../flight/format";
import { haversineMeters } from "../../flight/stats";
import { sunFactLabel } from "../../flight/sun";
import type { Flight, Pin } from "../../storage/db";
import { useSettings } from "../settings/SettingsContext";
import { useLatestFlight } from "./useLatestFlight";
import { useLiveViewPrefs } from "./useLiveViewPrefs";
import { usePlannedPins } from "./usePlannedPins";

import styles from "./FlightSurface.module.css";

/**
 * The pre-flight screen: a couple of quiet facts and one enormous button.
 *
 * Idle facts are all derived offline (tiles stay the app's entire network
 * surface). The sun fact needs a location: the last flight's launch, else
 * the first planned pin — where they last flew or where they're planning
 * is where a pilot flies next. No location, no line.
 *
 * Wired rather than propped, unlike its Armed/Recording siblings: those are
 * arms of FlightSurface's status switch, while this is a screen the shells
 * mount directly. Its data is idle-only and would otherwise be subscribed for
 * a whole flight to feed nothing.
 *
 * Renders only behind the app root's boot gate: pre-hydration the engine
 * reports "idle", and Start Flight below clears the WAL — on an ungated render
 * that destroys a live flight still sitting in it, unread. If the gate ever
 * narrows, this dependency moves with it.
 */
export default function IdleSurface() {
  const { units } = useSettings();
  const plannedPins = usePlannedPins();
  // The newest logbook flight feeds the idle facts (the sun fact needs a
  // location; its launch point is the best guess for the next one).
  const lastFlight = useLatestFlight();
  const liveView = useLiveViewPrefs();

  async function onStart() {
    // Arming resets the live view to the flight's default: snapped to the
    // aircraft, north-up. (Unsnapping later takes track-up down with it —
    // see RecordingSurface's changeFollow.) Written through before the
    // status flips, because FlightSurface reads it back on mount.
    liveView.update({ follow: true });
    liveView.update({ trackUp: false });
    await startFlight();
  }

  // The sun fact is relative time through most of the cycle; re-render
  // by the minute while this surface is up so it cannot go stale on a
  // propped phone.
  useMinuteTick();

  const sunFact = sunFactFor(lastFlight, plannedPins);
  const plannedRouteMeters = routeMeters(plannedPins);
  const hasPlannedRoute = plannedRouteMeters > 0;

  return (
    <div className={styles.content} data-testid="fly-content">
      <div className={styles.idle}>
        <div className={styles.facts} data-testid="idle-facts">
          {sunFact && <div>{sunFact}</div>}
          {hasPlannedRoute && (
            <div data-testid="planned-route">
              Planned route: {formatDistance(plannedRouteMeters, units)}
            </div>
          )}
        </div>
        <button className={styles.start} onClick={() => void onStart()}>
          Start Flight
        </button>
      </div>
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
