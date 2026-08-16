import { describe, expect, it } from "vitest";

import type { Fix } from "../engine/types";
import { isLanded, LANDING_SUSTAIN_FIXES } from "./landing";

function fix(speed: number, overrides: Partial<Fix> = {}): Fix {
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
    ...overrides,
  };
}

const launch = fix(0);
const flying = Array.from({ length: 20 }, () => fix(10));

function slowFixes(count: number, overrides: Partial<Fix> = {}): Fix[] {
  return Array.from({ length: count }, () => fix(0.3, overrides));
}

describe("isLanded", () => {
  it("is false while flying", () => {
    expect(isLanded(flying, launch)).toBe(false);
  });

  it("is false during a brief slowdown", () => {
    const track = [...flying, ...slowFixes(LANDING_SUSTAIN_FIXES - 1)];
    expect(isLanded(track, launch)).toBe(false);
  });

  it("is true after sustained near-zero speed at the launch point", () => {
    const track = [...flying, ...slowFixes(LANDING_SUSTAIN_FIXES)];
    expect(isLanded(track, launch)).toBe(true);
  });

  it("resets when movement resumes", () => {
    const track = [
      ...flying,
      ...slowFixes(LANDING_SUSTAIN_FIXES - 1),
      fix(8),
      ...slowFixes(LANDING_SUSTAIN_FIXES - 1),
    ];
    expect(isLanded(track, launch)).toBe(false);
  });

  it("is false for a short track", () => {
    expect(isLanded(flying.slice(0, 5), launch)).toBe(false);
  });
});

// The field regression (flight of 2026-08): winds aloft can hold ground
// speed near zero indefinitely, so speed alone declared a pilot at
// altitude landed and the grace threatened the rest of the flight. A
// landing must also look like the launch site.
describe("isLanded aloft", () => {
  it("does not detect a slow-over-ground pilot high above launch", () => {
    const parked = slowFixes(LANDING_SUSTAIN_FIXES, { altitude: 600 });
    expect(isLanded([...flying, ...parked], launch)).toBe(false);
  });

  it("does not detect a slow pilot far from launch", () => {
    // ~0.005° latitude ≈ 550 m: at launch elevation but over the next field.
    const away = slowFixes(LANDING_SUSTAIN_FIXES, { latitude: 43.005 });
    expect(isLanded([...flying, ...away], launch)).toBe(false);
  });

  it("does not detect a windy final approach descending over launch", () => {
    // Ground speed under threshold the whole way down: only a held
    // altitude may complete the window.
    const descending = Array.from({ length: LANDING_SUSTAIN_FIXES }, (_, i) =>
      fix(0.5, { altitude: 330 - i * 1.3 }),
    );
    expect(isLanded([...flying, ...descending], launch)).toBe(false);
  });

  it("tolerates GPS altitude jitter on the ground", () => {
    const parked = Array.from({ length: LANDING_SUSTAIN_FIXES }, (_, i) =>
      fix(0.3, { altitude: 300 + (i % 3) * 2 }),
    );
    expect(isLanded([...flying, ...parked], launch)).toBe(true);
  });
});

// Each bound pinned within 2x from both sides, so a units slip (150 ft
// transcribed as 150 m, or 275 m as 275 ft) cannot pass the suite.
describe("isLanded thresholds", () => {
  it("accepts a landing ~220 m out and rejects ~330 m", () => {
    const near = slowFixes(LANDING_SUSTAIN_FIXES, { latitude: 43.002 });
    const far = slowFixes(LANDING_SUSTAIN_FIXES, { latitude: 43.003 });
    expect(isLanded([...flying, ...near], launch)).toBe(true);
    expect(isLanded([...flying, ...far], launch)).toBe(false);
  });

  it("accepts a landing 40 m below launch and rejects 50 m above", () => {
    const below = slowFixes(LANDING_SUSTAIN_FIXES, { altitude: 260 });
    const above = slowFixes(LANDING_SUSTAIN_FIXES, { altitude: 350 });
    expect(isLanded([...flying, ...below], launch)).toBe(true);
    expect(isLanded([...flying, ...above], launch)).toBe(false);
  });

  it("accepts 8 m of window drift and rejects 12 m", () => {
    const settled = Array.from({ length: LANDING_SUSTAIN_FIXES }, (_, i) =>
      fix(0.3, { altitude: 300 + (i % 2) * 8 }),
    );
    const drifting = Array.from({ length: LANDING_SUSTAIN_FIXES }, (_, i) =>
      fix(0.3, { altitude: 300 + (i % 2) * 12 }),
    );
    expect(isLanded([...flying, ...settled], launch)).toBe(true);
    expect(isLanded([...flying, ...drifting], launch)).toBe(false);
  });
});

// The earlier field regression (flight of 2026-07-10): a pilot packing up
// walks at ~1.2-2.0 m/s — above the old 1.0 threshold, so landing never
// detected and the walk saved into the flight of record.
describe("isLanded at walking pace", () => {
  it("detects a landing while the pilot walks around", () => {
    const walking = Array.from({ length: LANDING_SUSTAIN_FIXES }, (_, i) =>
      fix(1.2 + (i % 3) * 0.4),
    );
    expect(isLanded([...flying, ...walking], launch)).toBe(true);
  });

  it("does not detect during slow-but-flying speeds", () => {
    const slow = Array.from({ length: LANDING_SUSTAIN_FIXES }, () => fix(3.5));
    expect(isLanded([...flying, ...slow], launch)).toBe(false);
  });
});
