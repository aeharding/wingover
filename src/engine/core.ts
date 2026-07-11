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

// The PWA twin of the Swift shim's isIdleTimerDisabled: the screen stays
// awake while the watch runs. Doubly load-bearing here — a hidden PWA tab
// loses its geolocation watch and has no native buffer to replay
// (ARCHITECTURE.md), so every fix while the screen sleeps is gone from
// the track for good. Browsers release the sentinel whenever the page
// hides; re-acquire on return. Absent API (old browsers, tests):
// silently does nothing.
function createScreenWakeLock() {
  let sentinel: WakeLockSentinel | null = null;
  let active = false;

  async function acquire() {
    if (!active) return;
    if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
    try {
      sentinel = await navigator.wakeLock.request("screen");
    } catch {
      // Denied (battery saver, hidden page): recording is unaffected.
    }
  }

  function onVisibilityChange() {
    if (document.visibilityState === "visible") void acquire();
  }

  return {
    start() {
      active = true;
      void acquire();
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", onVisibilityChange);
      }
    },
    stop() {
      active = false;
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
      void sentinel?.release().catch(() => {});
      sentinel = null;
    },
  };
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
        // The watch carries every capability, wake lock included — the
        // exact counterpart of startCapture's isIdleTimerDisabled.
        const wakeLock = createScreenWakeLock();
        wakeLock.start();
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
          wakeLock.stop();
          core.stop();
        };
      },
    },
    setWaypoints: (waypoints) => core.setWaypoints(waypoints),
  };
}

export const webCore = withWebCore(navigatorPositionSource);
