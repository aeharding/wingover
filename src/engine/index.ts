import { webCore, withWebCore } from "./core";
import { createGpxSource } from "./gpxSource";
import { nativeCore } from "./nativeSource";
import { isTauri } from "./platform";
import { GeolocationRecordingEngine } from "./real";
import { createSimulatorSource } from "./simulatorSource";
import type { RecordingEngine } from "./types";

const initialSearch = typeof location === "undefined" ? "" : location.search;

// Real GPS everywhere by default: CoreLocation via the wingover plugin's
// native queue under Tauri, navigator.geolocation in any browser (dev and
// PWA alike).
//
// The mock engines (?mock-speed simulator, ?mock-gpx replay, ?mock-home start
// override) are a DEV / e2e / screenshots-only seam. import.meta.env.DEV is
// statically `false` in production builds, so this entire block — and the
// gpxSource/simulator modules it imports — is dead-code eliminated and
// tree-shaken out of the shipped app. A real recording can never reach it, so
// a crafted `?mock-gpx=<url>` link cannot make the shipped app fetch and
// replay an arbitrary URL as GPS.
function chooseEngine(): RecordingEngine {
  if (import.meta.env.DEV) {
    const params = new URLSearchParams(initialSearch);
    // ?mock-gpx replays a real (pre-clipped) GPX track, deterministically, and
    // holds at its final point. ?mock-speed sets the replay compression.
    if (params.has("mock-gpx")) {
      const parsed = Number(params.get("mock-speed"));
      const compression = Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
      return new GeolocationRecordingEngine(
        withWebCore(createGpxSource(params.get("mock-gpx")!, compression)),
      );
    }
    if (params.has("mock-speed")) {
      const parsed = Number(params.get("mock-speed"));
      const compression = Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
      return new GeolocationRecordingEngine(
        withWebCore(
          createSimulatorSource(compression, parseHome(params.get("mock-home"))),
        ),
      );
    }
  }
  return new GeolocationRecordingEngine(isTauri() ? nativeCore : webCore);
}

// Dev-only: override the simulator's start coordinate, e.g.
// ?mock-home=43.18,-90.13 to fly somewhere scenic. Referenced only inside the
// DEV block above, so it is stripped from production too.
function parseHome(
  raw: string | null,
): { latitude: number; longitude: number } | undefined {
  if (!raw) return undefined;
  const [lat, lon] = raw.split(",").map(Number);
  return Number.isFinite(lat) && Number.isFinite(lon)
    ? { latitude: lat, longitude: lon }
    : undefined;
}

export const engine: RecordingEngine = chooseEngine();
