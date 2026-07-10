import { webCore, withWebCore } from "./core";
import { nativeCore } from "./nativeSource";
import { isTauri } from "./platform";
import { GeolocationRecordingEngine } from "./real";
import { createSimulatorSource } from "./simulatorSource";
import type { RecordingEngine } from "./types";

const initialSearch = typeof location === "undefined" ? "" : location.search;

// Real GPS everywhere by default: CoreLocation via the wingover plugin's
// native queue under Tauri, navigator.geolocation in any browser (dev and
// PWA alike). The simulator is strictly opt-in via ?mock-speed=N.
function chooseEngine(): RecordingEngine {
  const params = new URLSearchParams(initialSearch);
  if (params.has("mock-speed")) {
    const parsed = Number(params.get("mock-speed"));
    const compression = Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
    return new GeolocationRecordingEngine(
      withWebCore(createSimulatorSource(compression)),
    );
  }
  return new GeolocationRecordingEngine(isTauri() ? nativeCore : webCore);
}

export const engine: RecordingEngine = chooseEngine();
