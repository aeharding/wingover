import { describe, expect, it } from "vitest";

import { bearingBetween, relativeBearing } from "./nav";

describe("bearingBetween", () => {
  it("points north to a point due north", () => {
    const bearing = bearingBetween(
      { latitude: 33, longitude: -112 },
      { latitude: 34, longitude: -112 },
    );
    expect(bearing).toBeCloseTo(0, 1);
  });

  it("points east to a point due east", () => {
    const bearing = bearingBetween(
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 1 },
    );
    expect(bearing).toBeCloseTo(90, 1);
  });

  it("points southwest back toward launch", () => {
    const bearing = bearingBetween(
      { latitude: 33.9, longitude: -112.2 },
      { latitude: 33.865, longitude: -112.27 },
    );
    expect(bearing).toBeGreaterThan(180);
    expect(bearing).toBeLessThan(270);
  });
});

describe("relativeBearing", () => {
  it("is zero when the target is dead ahead", () => {
    expect(relativeBearing(90, 90)).toBe(0);
  });

  it("is negative when the target is to the left", () => {
    expect(relativeBearing(0, 350)).toBe(-10);
    expect(relativeBearing(90, 80)).toBe(-10);
  });

  it("is positive when the target is to the right", () => {
    expect(relativeBearing(0, 19)).toBe(19);
    expect(relativeBearing(350, 10)).toBe(20);
  });

  it("wraps a target dead astern to -180", () => {
    expect(relativeBearing(0, 180)).toBe(-180);
  });
});
