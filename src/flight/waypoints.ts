import type { Fix, Waypoint } from "../engine/types";
import { haversineMeters } from "./stats";

export type { Waypoint } from "../engine/types";

// Waypoint announcement decisions — the TS twin of the Rust announcer in
// tauri-plugin-wingover (which handles native, background included; this module
// drives the web annunciator and future visual state). Semantics are pinned
// by the shared golden vectors in src/flight/golden.json, executed by both
// test suites — divergence fails CI in both languages.

export const DEFAULT_WAYPOINT_RADIUS_M = 200;

export interface WaypointTracker {
  setWaypoints(waypoints: Waypoint[]): void;
  ingest(fix: Pick<Fix, "latitude" | "longitude">): string[];
}

export function createWaypointTracker(): WaypointTracker {
  let waypoints: Waypoint[] = [];
  // true = currently inside; entries absent until the first fix arms them
  const inside = new Map<string, boolean>();

  return {
    // Keeps arm state for waypoints whose definition is unchanged; a moved
    // or resized waypoint re-arms from the next fix.
    setWaypoints(next: Waypoint[]) {
      const kept = new Map<string, boolean>();
      for (const waypoint of next) {
        const previous = waypoints.find((w) => w.id === waypoint.id);
        if (
          previous &&
          previous.latitude === waypoint.latitude &&
          previous.longitude === waypoint.longitude &&
          previous.radiusM === waypoint.radiusM &&
          inside.has(waypoint.id)
        ) {
          kept.set(waypoint.id, inside.get(waypoint.id)!);
        }
      }
      waypoints = next;
      inside.clear();
      for (const [id, state] of kept) inside.set(id, state);
    },

    // Returns the announcements this fix triggers, in waypoint order.
    ingest(fix) {
      const announcements: string[] = [];
      for (const waypoint of waypoints) {
        const nowInside = haversineMeters(fix, waypoint) <= waypoint.radiusM;
        if (!inside.has(waypoint.id)) {
          // First fix arms without announcing: launching from inside your
          // own waypoint must not speak.
          inside.set(waypoint.id, nowInside);
        } else if (!inside.get(waypoint.id) && nowInside) {
          inside.set(waypoint.id, true);
          announcements.push("Waypoint reached");
        } else if (inside.get(waypoint.id) && !nowInside) {
          inside.set(waypoint.id, false);
        }
      }
      return announcements;
    },
  };
}
