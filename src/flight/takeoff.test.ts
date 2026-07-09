import { describe, expect, it } from "vitest";

import { FlightSimulator } from "../engine/simulator";
import type { Fix } from "../engine/types";
import {
  detectTakeoff,
  gpsReadyIndex,
  MOVEMENT_SPEED_MPS,
  TAKEOFF_SPEED_MPS,
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

describe("detectTakeoff", () => {
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
});
