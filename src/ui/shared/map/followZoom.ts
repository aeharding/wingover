import type { GestureEvent, MapView } from "./types";

// While a camera is FOLLOWING (the live flight map, a replay), the wheel
// is intercepted and applied as a pure zoom, directly and instantly (the
// finger/wheel IS the animation): the backend's native wheel zoom anchors
// at the cursor and pans, which the next follow re-center snaps back —
// visible fighting. The map is centered on the aircraft, so this zoom
// anchors there. Shared by the live map and the replay driver so the two
// never drift apart.
const WHEEL_ZOOM_RATE = 1 / 450;
const PINCH_ZOOM_RATE = 1 / 100; // trackpad pinch reports ctrlKey

/**
 * Returns the zoom the camera was moved to, or null when the tick was
 * skipped. Callers that persist the pilot's zoom read that number here:
 * this is a programmatic move, and no backend reports a zoom settle for
 * one, so nothing downstream will announce it (LiveTrackMap).
 */
export function applyFollowWheelZoom(
  map: MapView,
  event: GestureEvent,
): number | null {
  event.preventDefault?.();
  // This zoom is RELATIVE to the camera's own reading, so a backend that
  // cannot describe its camera cannot be zoomed by it: the reading would be
  // a fallback constant and the tick would jump the map to it. A tick lost
  // in that sub-second window costs the pilot nothing; a jump to a
  // continental view mid-flight costs them the map.
  if (!map.cameraReliable()) return null;
  const rate = event.ctrlKey ? PINCH_ZOOM_RATE : WHEEL_ZOOM_RATE;
  const { min, max } = map.zoomRange();
  const from = map.camera().zoom;
  const next = Math.min(max, Math.max(min, from - (event.deltaY ?? 0) * rate));
  map.moveTo({ zoom: next }, { animate: false });
  return next;
}
