import { invoke } from "@tauri-apps/api/core";

import type { PositionSource, SourcePosition } from "./real";

// Pull-based source over the wingover-location plugin. The native side
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
  watch(onPosition, onError, options) {
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let cursor = options?.since ?? 0;
    let inFlight = false;

    async function poll() {
      if (inFlight || stopped) return;
      inFlight = true;
      try {
        const response = await invoke<FixesResponse>(
          "plugin:wingover-location|fixes_since",
          { ts: cursor },
        );
        if (stopped) return;
        for (const fix of response.fixes) {
          cursor = Math.max(cursor, fix.timestamp);
          onPosition(toSourcePosition(fix));
        }
        // A stale error with fixes still flowing is already resolved.
        if (response.error !== undefined && response.fixes.length === 0) {
          onError({
            permissionDenied: /denied|permission/i.test(response.error),
            message: response.error,
          });
        }
      } catch (error) {
        if (!stopped) onError({ permissionDenied: false, message: String(error) });
      } finally {
        inFlight = false;
      }
    }

    (async () => {
      try {
        let status = await invoke<PermissionStatus>(
          "plugin:wingover-location|check_permissions",
        );
        if (status.location === "prompt") {
          status = await invoke<PermissionStatus>(
            "plugin:wingover-location|request_permissions",
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
        await invoke("plugin:wingover-location|start_watch");
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
      void invoke("plugin:wingover-location|stop_watch");
    };
  },
};
