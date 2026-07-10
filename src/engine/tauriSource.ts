import {
  checkPermissions,
  clearWatch,
  requestPermissions,
  watchPosition,
} from "@tauri-apps/plugin-geolocation";

import type { PositionSource } from "./real";

// CoreLocation via the Tauri geolocation plugin. Foreground parity with the
// browser source; background recording hardening (native WAL) is the M0
// on-hardware milestone.
export const tauriPositionSource: PositionSource = {
  watch(onPosition, onError) {
    let stopped = false;
    let watchId: number | null = null;

    (async () => {
      try {
        let status = await checkPermissions();
        if (
          status.location === "prompt" ||
          status.location === "prompt-with-rationale"
        ) {
          status = await requestPermissions(["location"]);
        }
        if (status.location !== "granted") {
          onError({
            permissionDenied: true,
            message: `location permission ${status.location}`,
          });
          return;
        }
        if (stopped) return;
        watchId = await watchPosition(
          { enableHighAccuracy: true, timeout: 30_000, maximumAge: 0 },
          (position, error) => {
            if (stopped) return;
            if (position) {
              onPosition(position);
            } else if (error) {
              onError({
                permissionDenied: /denied|permission/i.test(error),
                message: error,
              });
            }
          },
        );
        if (stopped && watchId !== null) void clearWatch(watchId);
      } catch (error) {
        onError({ permissionDenied: false, message: String(error) });
      }
    })();

    return () => {
      stopped = true;
      if (watchId !== null) void clearWatch(watchId);
    };
  },
};
