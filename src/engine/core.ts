import { createWaypointTracker } from "../flight/waypoints";
import {
  type CoreClient,
  navigatorPositionSource,
  type PositionSource,
} from "./real";
import type { Fix, Waypoint } from "./types";

// TS twin of the plugin's core.rs: the SAME surface, function for
// function, so the web path cannot drift from native without diverging
// from a named Rust counterpart. start = detection reset, stop = the
// flight's waypoints die with its session, ingest returns announcement
// decisions (the caller speaks, playing the Rust ingest thread's role).
export interface Core {
  start(): void;
  stop(): void;
  setWaypoints(waypoints: Waypoint[]): void;
  ingest(batch: Array<Pick<Fix, "latitude" | "longitude">>): string[];
}

export class WebCore implements Core {
  private waypoints: Waypoint[] = [];
  private tracker = createWaypointTracker();

  // core.rs resets only on a FRESH session (a mid-flight process relaunch
  // keeps arm state via its store); on the web every watch (re)start is
  // either a new session or a fresh page, so an unconditional reset is
  // behaviorally identical.
  start() {
    this.tracker = createWaypointTracker();
    this.tracker.setWaypoints(this.waypoints);
  }

  stop() {
    this.waypoints = [];
    this.tracker = createWaypointTracker();
  }

  setWaypoints(waypoints: Waypoint[]) {
    this.waypoints = waypoints;
    this.tracker.setWaypoints(waypoints);
  }

  ingest(batch: Array<Pick<Fix, "latitude" | "longitude">>): string[] {
    const announcements: string[] = [];
    for (const fix of batch) {
      announcements.push(...this.tracker.ingest(fix));
    }
    return announcements;
  }
}

function speak(text: string) {
  if (typeof speechSynthesis === "undefined") return;
  speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

// Wrap any capture source with the web core — the exact counterpart of
// nativeCore: the same watch that carries start_watch/stop_watch natively
// carries core.start/core.stop here, and the batch callback plays the
// Rust ingest thread's role (ingest → speak). Batches can come from the
// live browser sensor or the simulator; the core neither knows nor cares.
export function withWebCore(inner: PositionSource): CoreClient {
  const core = new WebCore();
  return {
    source: {
      watch(onPositions, onError, options) {
        core.start();
        const unwatch = inner.watch(
          (positions) => {
            const coords = positions.map((position) => position.coords);
            for (const text of core.ingest(coords)) speak(text);
            onPositions(positions);
          },
          onError,
          options,
        );
        return () => {
          unwatch();
          core.stop();
        };
      },
    },
    setWaypoints: (waypoints) => core.setWaypoints(waypoints),
  };
}

export const webCore = withWebCore(navigatorPositionSource);
