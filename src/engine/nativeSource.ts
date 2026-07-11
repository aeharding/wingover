import { invoke } from "@tauri-apps/api/core";

import type { CoreClient, PositionSource, SourcePosition } from "./real";
import type { Waypoint } from "./types";

// Pull-based source over the wingover plugin. The native side
// captures with CoreLocation (background delivery on) and buffers every
// fix for the session; we poll fixes_since(cursor) once a second. The
// same call serves live delivery AND post-reload catch-up — after a
// webview death the engine passes `since` from the rehydrated WAL and
// the backlog replays through the normal path. Only the returned
// unsubscribe (engine.stop, i.e. flight finalization) stops native
// capture and clears its session file; a page reload never does.
const POLL_MS = 1000;

interface NativeFix {
  timestamp: number;
  latitude: number;
  longitude: number;
  horizontalAccuracy: number;
  // Absent when CoreLocation reports the value invalid.
  altitude?: number;
  verticalAccuracy?: number;
  speed?: number;
  course?: number;
}

interface FixesResponse {
  fixes: NativeFix[];
  error?: string;
}

interface PermissionStatus {
  location: "granted" | "denied" | "prompt";
}

function toSourcePosition(fix: NativeFix): SourcePosition {
  return {
    timestamp: fix.timestamp,
    coords: {
      latitude: fix.latitude,
      longitude: fix.longitude,
      accuracy: fix.horizontalAccuracy,
      altitude: fix.altitude ?? null,
      altitudeAccuracy: fix.verticalAccuracy ?? null,
      speed: fix.speed ?? null,
      heading: fix.course ?? null,
    },
  };
}

export const nativePositionSource: PositionSource = {
  watch(onPositions, onError, options) {
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let cursor = options?.since ?? 0;
    let inFlight = false;

    async function poll() {
      if (inFlight || stopped) return;
      inFlight = true;
      try {
        const response = await invoke<FixesResponse>(
          "plugin:wingover|fixes_since",
          { ts: cursor },
        );
        if (stopped) return;
        // One poll response = one batch: a backlog replay reaches the
        // engine as a single call, not a loop of per-fix deliveries.
        if (response.fixes.length > 0) {
          for (const fix of response.fixes) {
            cursor = Math.max(cursor, fix.timestamp);
          }
          onPositions(response.fixes.map(toSourcePosition));
        }
        // A stale error with fixes still flowing is already resolved.
        if (response.error !== undefined && response.fixes.length === 0) {
          onError({
            permissionDenied: /denied|permission/i.test(response.error),
            message: response.error,
          });
        }
      } catch (error) {
        if (!stopped)
          onError({ permissionDenied: false, message: String(error) });
      } finally {
        inFlight = false;
      }
    }

    (async () => {
      try {
        let status = await invoke<PermissionStatus>(
          "plugin:wingover|check_permissions",
        );
        if (status.location === "prompt") {
          status = await invoke<PermissionStatus>(
            "plugin:wingover|request_permissions",
          );
        }
        if (status.location !== "granted") {
          onError({
            permissionDenied: true,
            message: `location permission ${status.location}`,
          });
          return;
        }
        if (stopped) return;
        await invoke("plugin:wingover|start_watch");
        if (stopped) return;
        void poll();
        timer = setInterval(() => void poll(), POLL_MS);
      } catch (error) {
        onError({ permissionDenied: false, message: String(error) });
      }
    })();

    return () => {
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
      // Finalize: stop CoreLocation and clear the native session file.
      // Tauri IPC is FIFO per webview, so a stop immediately followed by
      // a new watch's start_watch cannot be reordered.
      void invoke("plugin:wingover|stop_watch");
    };
  },
};

// The plugin surface bundled for the engine — the exact counterpart of
// webCore: the watch carries the core lifecycle
// (start_watch/stop_watch), setWaypoints is the set_waypoints command.
export const nativeCore: CoreClient = {
  source: nativePositionSource,
  setWaypoints(waypoints: Waypoint[]) {
    void invoke("plugin:wingover|set_waypoints", { waypoints }).catch((error) =>
      console.warn("set_waypoints failed:", error),
    );
  },
};
