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

// What refuses to record right now: one round trip to the real
// authorization API. null means nothing does — recordable (granted, full
// accuracy) or merely unasked ("prompt"), since the engine's answer to
// null is a watch bounce and the fresh watch does the ask. Only what the
// pilot must change in Settings — denied, Location Services off, Precise
// Location off — holds the screen, and the answer says WHICH of them
// stands at this moment: the pilot can trade one for another with no watch
// running, and the takeover must follow the current reason rather than the
// one that first raised it.
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

// The live watch, as revive() needs to see it. One plugin, one
// CoreLocation session, so there is one of these at a time; a teardown
// only clears it if a newer watch has not already taken it.
interface LiveWatch {
  report: (refusal: SourceError | null) => void;
  // What this watch last told the engine. revive() reports null only from
  // true: null means "bounce me", and bouncing a HEALTHY capture stops
  // CoreLocation and deletes the native session log for nothing. Every
  // foreground calls revive, so this is what keeps a running flight's
  // capture off the foreground path.
  refused: boolean;
}

let live: LiveWatch | null = null;

export const nativePositionSource: PositionSource = {
  watch(onPositions, onRefusal, options) {
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let cursor = options?.since ?? 0;
    let inFlight = false;

    const mine: LiveWatch = { report: onRefusal, refused: false };
    live = mine;

    // Every refusal this watch reports travels through here, so `refused`
    // cannot drift from what the engine was told.
    function refuse(refusal: SourceError) {
      mine.refused = true;
      onRefusal(refusal);
    }

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
          // Capture is delivering, so whatever this watch last refused
          // with is over — and a foreground must not bounce it.
          mine.refused = false;
          for (const fix of response.fixes) {
            cursor = Math.max(cursor, fix.timestamp);
          }
          onPositions(response.fixes.map(toSourcePosition));
        }
        // A stale error with fixes still flowing is already resolved.
        if (response.error != null && response.fixes.length === 0) {
          refuse(classifyDrainError(response.error));
        }
      } catch (error) {
        if (!stopped)
          refuse({
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
        // permission, including on the watch a revive bounces into.
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
          refuse(refusal);
          return;
        }
        await invoke("plugin:wingover|start_watch");
        if (stopped) return;
        void poll();
        timer = setInterval(() => void poll(), POLL_MS);
      } catch (error) {
        if (stopped) return;
        refuse({
          permissionDenied: /denied|permission/i.test(String(error)),
          imprecise: /precise/i.test(String(error)),
          message: String(error),
        });
      }
    })();

    return () => {
      stopped = true;
      if (live === mine) live = null;
      if (timer !== undefined) clearInterval(timer);
      // Finalize: stop CoreLocation and clear the native session file.
      // Tauri IPC is FIFO per webview, so a stop immediately followed by
      // a new watch's start_watch cannot be reordered.
      void invoke("plugin:wingover|stop_watch");
    };
  },

  // Every foreground and every Try Again lands here. Capture is
  // process-level and outlives the webview, so a foreground is no evidence
  // that anything changed — but a trip to Settings is a foreground too,
  // and while a takeover is up there is no watch running to notice what
  // the pilot did. So: ask the real authorization API, once, and report
  // what it says. A refusal that has not changed is silent at the engine;
  // null bounces the watch, and the fresh one does the asking.
  revive() {
    const watching = live;
    if (watching === null || !watching.refused) return;
    void nativeLocationRefusal()
      .then((refusal) => {
        // A watch torn down while the round trip was out must not report.
        if (live !== watching) return;
        if (refusal !== null) watching.refused = true;
        watching.report(refusal);
      })
      // The plugin not answering says nothing about what refuses, so
      // nothing is acted on: the takeover holds and the next foreground
      // asks again.
      .catch(() => {});
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
