import { WAYPOINT_RADIUS_M } from "../flight/waypoints";
import { listPins, type Pin } from "../storage/db";
import { getBooleanSetting } from "../storage/local";
import { engine } from "./index";
import type { Waypoint } from "./types";

// Foreground heal, wired HERE and not in a component (STEERING:
// anything that must happen regardless of which page is mounted is
// wired engine-side): coming back from Settings must PROCEED, not sit
// on a frozen screen. Safari can silently kill a watch while
// backgrounded; engine.retry() bounces it pre-takeoff (clearing a
// blocking error if one is up) and is a no-op wherever it could do
// harm (mid-flight, busy, healthy native capture). The other recovery
// mechanism — polling the source's readiness while blocked — is wired
// inside the engine itself, off the source's capability.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") engine.retry();
  });
}

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
