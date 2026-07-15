import { WAYPOINT_RADIUS_M } from "../flight/waypoints";
import { listPins, type Pin } from "../storage/db";
import { getBooleanSetting } from "../storage/local";
import { engine } from "./index";
import type { Waypoint } from "./types";

// Pins are planning documents; waypoints are anonymous geofence config.
// This projection is the only place one becomes the other — deliberately
// field-by-field so pin data (name, notes, whatever comes later) never
// crosses into the session or the native waypoints file.
function toWaypoint(pin: Pin): Waypoint {
  return {
    id: pin.id,
    latitude: pin.latitude,
    longitude: pin.longitude,
    radiusM: WAYPOINT_RADIUS_M,
  };
}

// Starting a flight copies the plan into the session: the Plan tab is a
// reusable template for the NEXT flight; an active flight owns its
// waypoints and never re-reads the plan (STEERING.md).
export async function startFlight(): Promise<void> {
  const [pins, autoEnd] = await Promise.all([
    listPins(),
    getBooleanSetting("autoEndFlight", true),
  ]);
  await engine.start({
    waypoints: pins.map(toWaypoint),
    // The session copies the setting at start, like the waypoint plan:
    // an active flight keeps the behavior it took off with.
    autoEnd,
  });
}
