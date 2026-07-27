import { describe, expect, it } from "vitest";

import type { Fix } from "../engine/types";
import { FlightSimulator } from "./simulator";
import {
  coordsLookReduced,
  detectTakeoff,
  gpsReadyIndex,
  IMPRECISE_M,
  MOVEMENT_SPEED_MPS,
  TAKEOFF_SPEED_MPS,
  TAKEOFF_SUSTAIN_FIXES,
  takeoffAt,
} from "./takeoff";

interface FixSpec {
  speed: number;
  horizontalAccuracy?: number;
  verticalAccuracy?: number;
}

function fixesFrom(specs: (number | FixSpec)[]): Fix[] {
  return specs.map((spec, i) => {
    const s = typeof spec === "number" ? { speed: spec } : spec;
    return {
      timestamp: i * 1000,
      latitude: 0,
      longitude: 0,
      altitude: 0,
      speed: s.speed,
      course: 0,
      climbRate: 0,
      horizontalAccuracy: s.horizontalAccuracy ?? 5,
      verticalAccuracy: s.verticalAccuracy ?? 8,
    };
  });
}

describe("gpsReadyIndex", () => {
  it("waits for sustained accuracy in a simulated startup", () => {
    const track = new FlightSimulator(42, 0).fixesUpTo(120);
    const index = gpsReadyIndex(track);
    expect(index).not.toBeNull();
    expect(index!).toBeGreaterThan(5);
    expect(index!).toBeLessThan(40);
  });

  it("returns null while accuracy is poor", () => {
    const track = fixesFrom([
      { speed: 0, horizontalAccuracy: 40, verticalAccuracy: 60 },
      { speed: 0, horizontalAccuracy: 35, verticalAccuracy: 50 },
      { speed: 0, horizontalAccuracy: 30, verticalAccuracy: 45 },
    ]);
    expect(gpsReadyIndex(track)).toBe(null);
  });
});

describe("coordsLookReduced", () => {
  // Raw source coordinates: a null altitudeAccuracy is no altitude
  // solution, which is how both platforms report one.
  const reduced = (accuracy: number, altitudeAccuracy: number | null) =>
    coordsLookReduced({ accuracy, altitudeAccuracy });

  it("flags the reduced-accuracy signature: km-coarse, no altitude", () => {
    expect(reduced(13_000, null)).toBe(true);
  });

  it("passes a coarse fix that still has an altitude solution", () => {
    expect(reduced(3000, 30)).toBe(false);
  });

  it("passes a cell-grade fix under the coarseness bar", () => {
    expect(reduced(IMPRECISE_M - 1, null)).toBe(false);
  });

  it("passes a sharp fix", () => {
    expect(reduced(5, 8)).toBe(false);
  });
});

describe("the takeoff rule", () => {
  it("detects takeoff in a simulated flight and backdates to movement start", () => {
    const track = new FlightSimulator(42, 0).fixesUpTo(300);
    const index = detectTakeoff(track);
    expect(index).not.toBeNull();
    expect(index!).toBeGreaterThan(30);
    expect(index!).toBeLessThan(60);
    expect(track[index!].speed).toBeGreaterThanOrEqual(MOVEMENT_SPEED_MPS);
    expect(track[index! - 1].speed).toBeLessThan(MOVEMENT_SPEED_MPS);
  });

  it("returns null while standing around", () => {
    expect(detectTakeoff(fixesFrom([0, 0.4, 0.2, 0.6, 0.1, 0.3]))).toBe(null);
  });

  it("ignores brief speed spikes", () => {
    expect(detectTakeoff(fixesFrom([0, 0, 6, 6, 6, 0.5, 0, 0.2]))).toBe(null);
  });

  it("ignores fast fixes with poor accuracy", () => {
    const track = fixesFrom([
      0,
      0,
      { speed: 9, horizontalAccuracy: 50, verticalAccuracy: 80 },
      { speed: 9, horizontalAccuracy: 45, verticalAccuracy: 70 },
      { speed: 9, horizontalAccuracy: 40, verticalAccuracy: 60 },
      { speed: 9, horizontalAccuracy: 35, verticalAccuracy: 55 },
      { speed: 9, horizontalAccuracy: 30, verticalAccuracy: 50 },
      0.2,
    ]);
    expect(detectTakeoff(track)).toBe(null);
  });

  it("backdates through the launch run", () => {
    expect(detectTakeoff(fixesFrom([0.2, 0.1, 2, 3, 4, 5.5, 6, 7, 8, 9]))).toBe(
      2,
    );
  });

  it("does not backdate across inaccurate fixes", () => {
    const track = fixesFrom([
      0.2,
      { speed: 3, horizontalAccuracy: 50 },
      3,
      4,
      5.5,
      6,
      7,
      8,
      9,
    ]);
    expect(detectTakeoff(track)).toBe(2);
  });

  it("starts at the first fast fix when there is no slow run-up", () => {
    expect(
      detectTakeoff(fixesFrom([0.2, 0.1, TAKEOFF_SPEED_MPS + 1, 6, 7, 8, 9])),
    ).toBe(2);
  });

  // On-device regression (2026-07-10): armed ground test at 15+ mph never
  // recorded — GPS accuracy degrades in motion and the old strict
  // two-axis check kept resetting the sustain run. Takeoff only needs a
  // credible speed: moderate horizontal accuracy, vertical irrelevant.
  it("triggers with degraded accuracy in motion", () => {
    const track = fixesFrom([
      0.2,
      { speed: 6.7, horizontalAccuracy: 18, verticalAccuracy: 40 },
      { speed: 7.0, horizontalAccuracy: 25, verticalAccuracy: 60 },
      { speed: 7.2, horizontalAccuracy: 12, verticalAccuracy: 25 },
      { speed: 6.9, horizontalAccuracy: 30, verticalAccuracy: 48 },
      { speed: 7.1, horizontalAccuracy: 22, verticalAccuracy: 35 },
    ]);
    expect(detectTakeoff(track)).toBe(1);
  });
});

describe("takeoffAt", () => {
  // The 24 s freeze (?mock-speed=1, a 94k-fix pre-takeoff backlog): the
  // engine asks per ingested fix, so a question whose cost grows with the
  // track behind it is quadratic over a batch. Counted, not timed, so it
  // cannot flake.
  it("reads a bounded number of fixes however long the track is", () => {
    const track = fixesFrom(new Array(5000).fill(0));
    let reads = 0;
    const counted = new Proxy(track, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && /^\d+$/.test(prop)) reads++;
        return Reflect.get(target, prop, receiver);
      },
    });

    expect(takeoffAt(counted, track.length - 1)).toBe(null);
    expect(reads).toBeLessThanOrEqual(TAKEOFF_SUSTAIN_FIXES);
  });
});
