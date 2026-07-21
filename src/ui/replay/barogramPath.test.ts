import { describe, expect, it } from "vitest";

import type { Fix } from "../../engine/types";
import { barogramPaths, bucketAltitudes, MIN_RANGE_M } from "./barogramPath";

function fix(timestamp: number, altitude: number): Fix {
  return {
    timestamp,
    latitude: 0,
    longitude: 0,
    altitude,
    speed: 0,
    course: 0,
    climbRate: 0,
    horizontalAccuracy: 5,
    verticalAccuracy: 5,
  };
}

function track(altitudes: number[]): Fix[] {
  return altitudes.map((altitude, i) => fix(i * 1000, altitude));
}

describe("bucketAltitudes", () => {
  it("keeps a single-fix spike through heavy downsampling", () => {
    const altitudes = Array.from({ length: 100 }, () => 100);
    altitudes[55] = 200;
    const { mins, maxs } = bucketAltitudes(track(altitudes), 10);
    // Fix 55 lands mid-track; its column keeps both the spike and the floor.
    const spikeCol = Math.min(9, Math.floor((55_000 / 99_000) * 10));
    expect(maxs[spikeCol]).toBe(200);
    expect(mins[spikeCol]).toBe(100);
    for (let c = 0; c < 10; c++) {
      if (c === spikeCol) continue;
      expect(maxs[c]).toBe(100);
      expect(mins[c]).toBe(100);
    }
  });

  it("buckets by time, not index", () => {
    // Two fixes, then a long silence, then two more: the gap columns are
    // empty rather than the fixes being spread evenly.
    const fixes = [
      fix(0, 100),
      fix(1000, 110),
      fix(99_000, 120),
      fix(100_000, 130),
    ];
    const { maxs } = bucketAltitudes(fixes, 10);
    expect(maxs[0]).toBe(110);
    expect(maxs[9]).toBe(130);
    expect(maxs[5]).toBe(-Infinity);
  });

  it("a zoomed window sees only its fixes, spread across all columns", () => {
    const fixes = Array.from({ length: 101 }, (_, i) => fix(i * 1000, i));
    // Zoom to the middle fifth: 40s..60s.
    const { mins, maxs } = bucketAltitudes(fixes, 10, 40_000, 60_000);
    expect(maxs[0]).toBe(41); // 40s and 41s land in column 0
    expect(mins[0]).toBe(40);
    expect(maxs[9]).toBe(60); // the window-end fix clamps into the last column
    // Nothing outside the window leaks in.
    const seen = [...maxs].filter((v) => v !== -Infinity);
    expect(Math.max(...seen)).toBeLessThanOrEqual(60);
    expect(Math.min(...[...mins].filter((v) => v !== Infinity))).toBe(40);
  });
});

describe("barogramPaths", () => {
  it("renders nothing for degenerate inputs", () => {
    expect(barogramPaths([], 390, 64)).toEqual({ area: "", outline: "" });
    expect(barogramPaths([fix(0, 100)], 390, 64)).toEqual({
      area: "",
      outline: "",
    });
    expect(barogramPaths(track([1, 2, 3]), 1, 64)).toEqual({
      area: "",
      outline: "",
    });
  });

  it("produces finite closed paths", () => {
    const { area, outline } = barogramPaths(
      track([100, 120, 180, 160, 140, 105]),
      390,
      64,
    );
    for (const d of [area, outline]) {
      expect(d.startsWith("M")).toBe(true);
      expect(d.endsWith("Z")).toBe(true);
      expect(d).not.toContain("NaN");
      expect(d).not.toContain("Infinity");
    }
  });

  it("pads a flat flight to the floor range instead of amplifying noise", () => {
    // 1m of altitude jitter over a 64px-tall chart: with the floor range the
    // profile must stay within ~1/MIN_RANGE of the height, not span it.
    const { outline } = barogramPaths(
      track([100, 100.5, 100, 100.5, 100, 100.5, 100]),
      100,
      64,
    );
    const ys = [...outline.matchAll(/[\d.]+ ([\d.]+)/g)].map((m) =>
      Number(m[1]),
    );
    const spread = Math.max(...ys) - Math.min(...ys);
    expect(spread).toBeLessThanOrEqual((64 * 1) / MIN_RANGE_M + 1);
  });
});
