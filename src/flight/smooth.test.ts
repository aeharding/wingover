import { describe, expect, it } from "vitest";

import { smoothFinishedTrack, smoothLiveTrack } from "./smooth";

function point(latitude: number, longitude: number) {
  return { latitude, longitude };
}

// A gentle right turn: heading changes each fix.
const turning = [
  point(43.0, -89.4),
  point(43.001, -89.4),
  point(43.002, -89.399),
  point(43.0025, -89.397),
  point(43.0025, -89.395),
  point(43.002, -89.393),
];

describe("smoothLiveTrack", () => {
  it("passes through every recorded fix", () => {
    const coords = smoothLiveTrack(turning);
    for (const fix of turning.slice(0, -1)) {
      expect(
        coords.some(
          ([lng, lat]) =>
            Math.abs(lng - fix.longitude) < 1e-9 &&
            Math.abs(lat - fix.latitude) < 1e-9,
        ),
      ).toBe(true);
    }
  });

  it("never reshapes drawn geometry — strict prefix under append", () => {
    for (let k = 1; k < turning.length; k++) {
      const before = smoothLiveTrack(turning.slice(0, k));
      const after = smoothLiveTrack(turning.slice(0, k + 1));
      expect(after.slice(0, before.length)).toEqual(before);
    }
  });

  it("adds no points on straight cruise", () => {
    const straight = Array.from({ length: 10 }, (_, i) =>
      point(43 + i * 0.001, -89.4),
    );
    const coords = smoothLiveTrack(straight);
    // One coord per finalized fix: collinear fixes need no subdivisions.
    expect(coords.length).toBe(straight.length - 1);
  });

  it("densifies turns", () => {
    const coords = smoothLiveTrack(turning);
    expect(coords.length).toBeGreaterThan(turning.length - 1);
  });
});

describe("smoothFinishedTrack", () => {
  it("includes the final fix", () => {
    const coords = smoothFinishedTrack(turning);
    const last = turning[turning.length - 1];
    const [lng, lat] = coords[coords.length - 1];
    expect(lng).toBeCloseTo(last.longitude, 9);
    expect(lat).toBeCloseTo(last.latitude, 9);
  });
});
