import type { Fix } from "../engine/types";
import { bearingBetween, relativeBearing } from "./nav";

type Point = Pick<Fix, "latitude" | "longitude">;
export type LngLat = [number, number];

// Density is turn-adaptive: straight cruise adds no points, hard turns
// get up to MAX_SUBDIVISIONS. Keeps a multi-hour track's point budget
// near the raw fix count.
const MAX_SUBDIVISIONS = 8;
const DEGREES_PER_SUBDIVISION = 3;

function catmullRom(
  v0: number,
  v1: number,
  v2: number,
  v3: number,
  t: number,
): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * v1 +
      (-v0 + v2) * t +
      (2 * v0 - 5 * v1 + 4 * v2 - v3) * t2 +
      (-v0 + 3 * v1 - 3 * v2 + v3) * t3)
  );
}

// Coords for the p1→p2 span of a Catmull-Rom through p0..p3, excluding
// p1 (the previous segment emitted it) and landing exactly on p2 — the
// curve passes through every recorded fix.
export function smoothSegment(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
): LngLat[] {
  const turn = Math.max(
    Math.abs(relativeBearing(bearingBetween(p0, p1), bearingBetween(p1, p2))),
    Math.abs(relativeBearing(bearingBetween(p1, p2), bearingBetween(p2, p3))),
  );
  const subdivisions = Math.max(
    1,
    Math.min(MAX_SUBDIVISIONS, Math.ceil(turn / DEGREES_PER_SUBDIVISION)),
  );
  const coords: LngLat[] = [];
  for (let s = 1; s <= subdivisions; s++) {
    const t = s / subdivisions;
    coords.push([
      catmullRom(p0.longitude, p1.longitude, p2.longitude, p3.longitude, t),
      catmullRom(p0.latitude, p1.latitude, p2.latitude, p3.latitude, t),
    ]);
  }
  return coords;
}

// Live tracks are append-only in shape, not just in length: segment
// i-1→i is emitted only once its trailing control fix (i+1) exists, so
// a segment's geometry is FINAL the moment it is drawn — new fixes
// extend the line, never reshape it. The newest (pending) segment is
// withheld; the live map's aircraft tail bridges the last coord to the
// playhead. smoothLiveTrack(fixes.slice(0, k)) is always a strict
// prefix of smoothLiveTrack(fixes.slice(0, k + 1)).
export function smoothLiveTrack(fixes: readonly Point[]): LngLat[] {
  if (fixes.length === 0) return [];
  const coords: LngLat[] = [[fixes[0].longitude, fixes[0].latitude]];
  for (let i = 1; i < fixes.length - 1; i++) {
    coords.push(
      ...smoothSegment(fixes[i - 2] ?? fixes[i - 1], fixes[i - 1], fixes[i], fixes[i + 1]),
    );
  }
  return coords;
}

// Finished tracks (detail page) include the last segment, end-clamped.
export function smoothFinishedTrack(fixes: readonly Point[]): LngLat[] {
  if (fixes.length === 0) return [];
  const coords: LngLat[] = [[fixes[0].longitude, fixes[0].latitude]];
  for (let i = 1; i < fixes.length; i++) {
    coords.push(
      ...smoothSegment(
        fixes[i - 2] ?? fixes[i - 1],
        fixes[i - 1],
        fixes[i],
        fixes[i + 1] ?? fixes[i],
      ),
    );
  }
  return coords;
}
