import { invoke } from "@tauri-apps/api/core";

import type {
  CoreClient,
  PositionSource,
  SourceError,
  SourcePosition,
} from "./real";
import type { Waypoint } from "./types";

// Pull-based source over the wingover plugin. The native side
// captures with CoreLocation (background delivery on) and buffers every
// fix for the session; we poll fixes_since(cursor) once a second. The
// same call serves live delivery AND post-reload catch-up — after a
// webview death the engine passes `since` from the rehydrated WAL and
// the backlog replays through the normal path. Only the returned
// unsubscribe (engine.discard, i.e. flight collection) stops native
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

export interface FixesResponse {
  fixes: NativeFix[];
  error?: string | null;
}

export interface PermissionStatus {
  location: "granted" | "denied" | "prompt";
  // false when iOS Precise Location is off for Wingover. Optional so an
  // older native shell (missing the key) never reads as imprecise.
  precise?: boolean;
  // false when the DEVICE-wide location switch is off, whatever this app
  // was granted. Optional for the same reason: an older shell omits it and
  // must not read as services-off.
  servicesEnabled?: boolean;
}

// Codes are the wire contract (see WingoverPlugin.swift); the prose
// fallbacks cover didFailWithError's localized messages, which are
// locale-dependent and classify only in English. Pinned by the
// fixes_since contract fixtures.
export function classifyDrainError(message: string): SourceError {
  return {
    permissionDenied:
      message === "permission-denied" || /denied|permission/i.test(message),
    imprecise: message === "reduced-accuracy" || /precise/i.test(message),
    message,
  };
}

// The refusal DECISION lives here, not in Swift (the sensor layer senses
// and actuates; it does not decide). One rule serving both the watch's
// pre-capture gate and the blocked screen's recovery loop, so the two
// can never drift apart.
//
// "prompt" is NOT a refusal: the question has not been asked, and asking
// is the app's job, not a trip to Settings. Both callers resolve it the
// same way — the watch requests permissions before judging (below), and
// currentRefusal answers null so the engine retries, which bounces the watch
// into that same request with the app frontmost and the system alert
// finally appears. Treating it as a refusal is what left Settings ->
// Never -> Ask Next Time stuck on the red takeover until a SECOND trip
// out of the app.
export function permissionRefusal(
  status: PermissionStatus,
): SourceError | null {
  // The device-wide switch outranks the app's own grant: authorization can
  // read "granted" while Location Services is off, and capture would then
  // never start. Judged FIRST, and reported as a permission denial because
  // the fix is the same shape — a trip to Settings, not an in-app ask.
  // Today's iOS folds this into an app-level denial on its own (owner
  // device test); this covers the platforms and versions that do not.
  if (status.servicesEnabled === false)
    return {
      permissionDenied: true,
      message: "location services off",
    };
  if (status.location === "denied")
    return {
      permissionDenied: true,
      message: "location permission denied",
    };
  // Accuracy is only meaningful once authorization exists; before the ask
  // the pilot picks precision in the prompt itself.
  if (status.location === "prompt") return null;
  // Reduced accuracy can never pass the accuracy gate, so refuse before
  // capture starts and let the error screen walk the pilot to Settings.
  if (status.precise === false)
    return {
      permissionDenied: false,
      imprecise: true,
      message: "precise location disabled",
    };
  return null;
}

// What refuses to record right now, for the blocked screen's recovery
// loop. null means nothing does: recordable (granted, full accuracy) or
// merely unasked ("prompt"), since the engine's answer to null is a watch
// bounce and the fresh watch does the ask. Only what the pilot must
// change in Settings — denied, Location Services off, Precise Location
// off — holds the screen, and the answer says WHICH of them stands at
// this moment: the pilot can trade one for another with no watch running,
// and the takeover must follow the current reason rather than the one
// that first raised it.
export async function nativeLocationRefusal(): Promise<SourceError | null> {
  const status = await invoke<PermissionStatus>(
    "plugin:wingover|check_permissions",
  );
  return permissionRefusal(status);
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
  // CoreLocation reports accuracyAuthorization directly — the engine's
  // fix-signature heuristic must stay out of the way. Capture is
  // process-level and survives webview visibility, so no foreground
  // bounce either; recovery is the currentRefusal loop.
  reportsAccuracyAuthorization: true,
  currentRefusal: nativeLocationRefusal,
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
        if (response.error != null && response.fixes.length === 0) {
          onError(classifyDrainError(response.error));
        }
      } catch (error) {
        if (!stopped)
          onError({
            permissionDenied: false,
            imprecise: /precise/i.test(String(error)),
            message: String(error),
          });
      } finally {
        inFlight = false;
      }
    }

    (async () => {
      try {
        let status = await invoke<PermissionStatus>(
          "plugin:wingover|check_permissions",
        );
        // The ask, and the only place it happens: permissionRefusal
        // returns no refusal for "prompt" precisely so this sequence —
        // not a trip to Settings — is what resolves an unasked
        // permission, including on the retry that recovery polling fires.
        if (status.location === "prompt") {
          status = await invoke<PermissionStatus>(
            "plugin:wingover|request_permissions",
          );
        }
        // A bounced watch's stale permission round-trip must not push an
        // error at the engine after a newer watch took over.
        if (stopped) return;
        const refusal = permissionRefusal(status);
        if (refusal !== null) {
          onError(refusal);
          return;
        }
        await invoke("plugin:wingover|start_watch");
        if (stopped) return;
        void poll();
        timer = setInterval(() => void poll(), POLL_MS);
      } catch (error) {
        if (stopped) return;
        onError({
          permissionDenied: /denied|permission/i.test(String(error)),
          imprecise: /precise/i.test(String(error)),
          message: String(error),
        });
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
