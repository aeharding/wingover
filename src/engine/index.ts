import { MockRecordingEngine } from "./mock";
import { GeolocationRecordingEngine } from "./real";
import { tauriPositionSource } from "./tauriSource";
import type { RecordingEngine } from "./types";

const initialSearch = typeof location === "undefined" ? "" : location.search;

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// Mock when explicitly requested (?mock-speed) or by default in browser dev,
// where a desk has no GPS worth recording. Native apps always use
// CoreLocation via the Tauri plugin. ?engine=real forces the browser real
// engine (e2e); production PWA builds record real GPS too.
function chooseEngine(): RecordingEngine {
  const params = new URLSearchParams(initialSearch);
  if (params.has("mock-speed")) return new MockRecordingEngine();
  if (isTauri()) return new GeolocationRecordingEngine(tauriPositionSource);
  if (params.get("engine") === "real") return new GeolocationRecordingEngine();
  if (import.meta.env.DEV) return new MockRecordingEngine();
  return new GeolocationRecordingEngine();
}

export const engine: RecordingEngine = chooseEngine();
