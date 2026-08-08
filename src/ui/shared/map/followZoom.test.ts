import { describe, expect, it } from "vitest";

import { applyFollowWheelZoom } from "./followZoom";
import type { Camera, GestureEvent, MapView } from "./types";

// Only the four members the wheel zoom touches. A whole MapView stub would
// say nothing more and would rot on every interface change.
function fakeMap(zoom: number, reliable = true) {
  const moves: Partial<Camera>[] = [];
  const map = {
    camera: () => ({
      center: [-122.4, 37.8] as [number, number],
      zoom,
      bearing: 0,
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
    }),
    cameraReliable: () => reliable,
    zoomRange: () => ({ min: 2, max: 20 }),
    moveTo: (to: Partial<Camera>) => {
      moves.push(to);
      if (to.zoom !== undefined) zoom = to.zoom;
    },
  };
  return { map: map as unknown as MapView, moves };
}

const wheel = (deltaY: number, ctrlKey = false): GestureEvent => ({
  at: [-122.4, 37.8],
  deltaY,
  ctrlKey,
});

describe("the follow-mode wheel zoom", () => {
  it("reports the zoom it applied, so the caller can persist it", () => {
    const { map, moves } = fakeMap(13);

    const applied = applyFollowWheelZoom(map, wheel(-450));

    expect(applied).toBe(14);
    expect(moves).toEqual([{ zoom: 14 }]);
  });

  it("reports the CLAMPED zoom, not the one asked for", () => {
    const { map } = fakeMap(19.5);

    expect(applyFollowWheelZoom(map, wheel(-450))).toBe(20);
  });

  it("zooms faster for a trackpad pinch", () => {
    const { map } = fakeMap(13);

    expect(applyFollowWheelZoom(map, wheel(-100, true))).toBe(14);
  });

  it("skips the tick while the backend cannot describe its camera", () => {
    const { map, moves } = fakeMap(13, false);

    // The zoom is relative to camera().zoom, which is a fallback constant
    // in that window: acting on it would jump the map, and persisting it
    // would carry the jump into the next flight.
    expect(applyFollowWheelZoom(map, wheel(-450))).toBeNull();
    expect(moves).toEqual([]);
  });
});
