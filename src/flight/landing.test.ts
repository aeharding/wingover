import { describe, expect, it } from "vitest";

import type { Fix } from "../engine/types";
import { isLanded, LANDING_SUSTAIN_FIXES } from "./landing";

function fix(speed: number): Fix {
  return {
    timestamp: 0,
    latitude: 43,
    longitude: -89.4,
    altitude: 300,
    speed,
    course: 0,
    climbRate: 0,
    horizontalAccuracy: 5,
    verticalAccuracy: 8,
  };
}

const flying = Array.from({ length: 20 }, () => fix(10));

describe("isLanded", () => {
  it("is false while flying", () => {
    expect(isLanded(flying)).toBe(false);
  });

  it("is false during a brief slowdown", () => {
    const track = [
      ...flying,
      ...Array.from({ length: LANDING_SUSTAIN_FIXES - 1 }, () => fix(0.3)),
    ];
    expect(isLanded(track)).toBe(false);
  });

  it("is true after sustained near-zero speed", () => {
    const track = [
      ...flying,
      ...Array.from({ length: LANDING_SUSTAIN_FIXES }, () => fix(0.3)),
    ];
    expect(isLanded(track)).toBe(true);
  });

  it("resets when movement resumes", () => {
    const track = [
      ...flying,
      ...Array.from({ length: LANDING_SUSTAIN_FIXES - 1 }, () => fix(0.3)),
      fix(8),
      ...Array.from({ length: LANDING_SUSTAIN_FIXES - 1 }, () => fix(0.3)),
    ];
    expect(isLanded(track)).toBe(false);
  });

  it("is false for a short track", () => {
    expect(isLanded(flying.slice(0, 5))).toBe(false);
  });
});

// The field regression (flight of 2026-07-10): a pilot packing up walks
// at ~1.2-2.0 m/s — above the old 1.0 threshold, so landing never
// detected and the walk saved into the flight of record.
describe("isLanded at walking pace", () => {
  it("detects a landing while the pilot walks around", () => {
    const walking = Array.from(
      { length: LANDING_SUSTAIN_FIXES },
      (_, i) => fix(1.2 + (i % 3) * 0.4),
    );
    expect(isLanded([...flying, ...walking])).toBe(true);
  });

  it("does not detect during slow-but-flying speeds", () => {
    const slow = Array.from({ length: LANDING_SUSTAIN_FIXES }, () => fix(3.5));
    expect(isLanded([...flying, ...slow])).toBe(false);
  });
});
