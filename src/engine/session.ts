import { DEFAULT_WAYPOINT_RADIUS_M } from "../flight/waypoints";
import { listPins, type Pin } from "../storage/db";
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
    radiusM: DEFAULT_WAYPOINT_RADIUS_M,
  };
}

// Starting a flight copies the plan into the session: the Plan tab is a
// reusable template for the NEXT flight; an active flight owns its
// waypoints and never re-reads the plan (STEERING.md).
export async function startFlight(): Promise<void> {
  const pins = await listPins();
  await engine.start({ waypoints: pins.map(toWaypoint) });
}
