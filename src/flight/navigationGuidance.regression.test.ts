import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import type { Fix } from "../engine/types";
import {
  deriveNavigationGuidance,
  type NavigationTarget,
} from "./navigationGuidance";

type FixtureRow = [
  elapsedMs: number,
  latitude: number,
  longitude: number,
  altitude: number,
  speed: number,
  course: number,
  climbRate: number,
  horizontalAccuracy: number,
  verticalAccuracy: number,
];

interface AnonymizedFixture {
  schema: 1;
  timestamp: number;
  rows: FixtureRow[];
}

function loadFixture(name: string): Fix[] {
  const compressed = Uint8Array.from(
    readFileSync(new URL(`./test-fixtures/${name}`, import.meta.url)),
  );
  const fixture = JSON.parse(
    gunzipSync(compressed).toString("utf8"),
  ) as AnonymizedFixture;
  expect(fixture.schema).toBe(1);
  return fixture.rows.map(
    ([
      elapsedMs,
      latitude,
      longitude,
      altitude,
      speed,
      course,
      climbRate,
      horizontalAccuracy,
      verticalAccuracy,
    ]) => ({
      timestamp: fixture.timestamp + elapsedMs,
      latitude,
      longitude,
      altitude,
      speed,
      course,
      climbRate,
      horizontalAccuracy,
      verticalAccuracy,
    }),
  );
}

function launchTarget(track: readonly Fix[]): NavigationTarget {
  return {
    kind: "launch",
    latitude: track[0].latitude,
    longitude: track[0].longitude,
  };
}

function elapsedSeconds(track: readonly Fix[], index: number): number {
  return (track[index].timestamp - track[0].timestamp) / 1000;
}

function indexAt(track: readonly Fix[], seconds: number): number {
  return track.findIndex((_, index) => elapsedSeconds(track, index) >= seconds);
}

function etaMinutes(
  track: readonly Fix[],
  target: NavigationTarget,
  index: number,
): number | null {
  const guidance = deriveNavigationGuidance(track.slice(0, index + 1), target);
  return guidance?.etaSeconds == null ? null : guidance.etaSeconds / 60;
}

function maximumEtaStepNear(
  track: readonly Fix[],
  pressurePoints: readonly number[],
): number {
  const target = launchTarget(track);
  let maximum = 0;
  for (const seconds of pressurePoints) {
    const center = indexAt(track, seconds);
    let previous: number | null = null;
    for (let index = center - 2; index <= center + 2; index++) {
      const eta = etaMinutes(track, target, index);
      if (eta !== null && previous !== null) {
        maximum = Math.max(maximum, Math.abs(eta - previous));
      }
      previous = eta;
    }
  }
  return maximum;
}

function etasAt(track: readonly Fix[], seconds: readonly number[]): number[] {
  const target = launchTarget(track);
  return seconds.map((value) => {
    const eta = etaMinutes(track, target, indexAt(track, value));
    expect(eta).not.toBeNull();
    return eta!;
  });
}

describe("anonymized real-flight RTL regressions", () => {
  it("tracks the sustained wind increase without a one-fix ETA cliff", () => {
    const track = loadFixture("rtl-wind-change.anonymized.json.gz");
    const snapshots = etasAt(
      track,
      [61, 65, 67, 71, 75, 80].map((minute) => minute * 60),
    );

    expect(
      maximumEtaStepNear(
        track,
        [3889, 4051, 4174, 4197, 4209, 4329, 4407, 4464, 4518, 4535, 4760],
      ),
    ).toBeLessThan(1.25);
    expect(snapshots[1]).toBeGreaterThan(snapshots[0] + 5);
    expect(snapshots[3]).toBeGreaterThan(snapshots[1] + 8);
    expect(snapshots[4]).toBeGreaterThan(40);
    expect(snapshots[5]).toBeGreaterThan(40);
  });

  it("does not reproduce either reported August model jump", () => {
    const track = loadFixture("rtl-model-jump.anonymized.json.gz");
    const firstRegion = etasAt(track, [5145, 5146, 5147]);
    const secondRegion = etasAt(track, [5387, 5388, 5389]);

    expect(maximumEtaStepNear(track, [5139, 5145, 5356, 5388])).toBeLessThan(
      1.3,
    );
    expect(Math.max(...firstRegion) - Math.min(...firstRegion)).toBeLessThan(
      0.1,
    );
    expect(Math.max(...secondRegion) - Math.min(...secondRegion)).toBeLessThan(
      0.1,
    );
    expect(firstRegion[1]).toBeCloseTo(17.4, 1);
    expect(secondRegion[1]).toBeCloseTo(17.6, 1);
  });
});
