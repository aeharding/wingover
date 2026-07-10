import { MockRecordingEngine } from "./mock";
import { nativePositionSource } from "./nativeSource";
import { GeolocationRecordingEngine } from "./real";
import type { RecordingEngine } from "./types";

const initialSearch = typeof location === "undefined" ? "" : location.search;

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// Mock when explicitly requested (?mock-speed) or by default in browser dev,
// where a desk has no GPS worth recording. Native apps use CoreLocation via
// the wingover-location plugin's native queue. ?engine=real forces the
// browser real engine (e2e); production PWA builds record real GPS too.
function chooseEngine(): RecordingEngine {
  const params = new URLSearchParams(initialSearch);
  if (params.has("mock-speed")) return new MockRecordingEngine();
  if (isTauri()) return new GeolocationRecordingEngine(nativePositionSource);
  if (params.get("engine") === "real") return new GeolocationRecordingEngine();
  if (import.meta.env.DEV) return new MockRecordingEngine();
  return new GeolocationRecordingEngine();
}

export const engine: RecordingEngine = chooseEngine();
