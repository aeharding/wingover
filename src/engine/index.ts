import { MockRecordingEngine } from "./mock";
import { GeolocationRecordingEngine } from "./real";
import type { RecordingEngine } from "./types";

const initialSearch = typeof location === "undefined" ? "" : location.search;

// Mock when explicitly requested (?mock-speed) or by default in dev, where
// a desk has no GPS worth recording. ?engine=real forces the real engine
// (e2e, on-device dev). Production builds always record real GPS.
function chooseEngine(): RecordingEngine {
  const params = new URLSearchParams(initialSearch);
  if (params.has("mock-speed")) return new MockRecordingEngine();
  if (params.get("engine") === "real") return new GeolocationRecordingEngine();
  if (import.meta.env.DEV) return new MockRecordingEngine();
  return new GeolocationRecordingEngine();
}

export const engine: RecordingEngine = chooseEngine();
