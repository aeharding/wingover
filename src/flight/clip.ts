import type { Fix } from "../engine/types";
import { haversineMeters } from "./stats";

// The floor under every clip: trim keeps at least this much recording,
// and each half of a split gets at least this much. Well above replay's
// 10-second availability threshold, so no edit can ever produce a flight
// too short to watch, and short hops simply don't offer the tools.
export const MIN_CLIP_SPAN_MS = 60_000;

function spanMs(track: Fix[]): number {
  return track.length >= 2
    ? track[track.length - 1].timestamp - track[0].timestamp
    : 0;
}

/** Whether there is anything to trim: the recording must outspan the floor. */
export function trimAvailable(track: Fix[]): boolean {
  return spanMs(track) > MIN_CLIP_SPAN_MS;
}

/** Both halves of a split must clear the floor, so it needs twice of it. */
export function splitAvailable(track: Fix[]): boolean {
  return spanMs(track) > 2 * MIN_CLIP_SPAN_MS;
}

// First index with timestamp >= t / > t, over the timestamp-sorted track.
// Times may be fractional (they come from barogram pixels), so the pair
// can't be derived from one another by nudging t by a millisecond.
function lowerBound(track: Fix[], t: number): number {
  let lo = 0;
  let hi = track.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (track[mid].timestamp < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(track: Fix[], t: number): number {
  let lo = 0;
  let hi = track.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (track[mid].timestamp <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The inclusive index window [from, to] of the fixes inside
 * [startMs, endMs]. from > to when the window holds no fixes.
 */
export function windowIndices(
  track: Fix[],
  startMs: number,
  endMs: number,
): { from: number; to: number } {
  return { from: lowerBound(track, startMs), to: upperBound(track, endMs) - 1 };
}

/** The fixes inside the inclusive [startMs, endMs] window. */
export function sliceTrack(
  track: Fix[],
  startMs: number,
  endMs: number,
): Fix[] {
  const { from, to } = windowIndices(track, startMs, endMs);
  return track.slice(from, to + 1);
}

/**
 * Split at t: fixes through t make the first half, and the second half
 * STARTS AT the boundary fix — the halves share that one point (per
 * Alex), so the second flight takes off exactly where the first lands:
 * no gap between the two lines on a map, and the two durations add up
 * to the whole recording.
 */
export function splitTrack(
  track: Fix[],
  t: number,
): { first: Fix[]; second: Fix[] } {
  const at = upperBound(track, t);
  return {
    first: track.slice(0, at),
    second: track.slice(Math.max(0, at - 1)),
  };
}

/**
 * Meters flown up to each fix, so a window's distance is
 * cum[to] - cum[from]: O(n) once per track (the compiler memoizes it),
 * O(1) per handle move — no throttling needed for the live preview.
 */
export function cumulativeDistances(track: Fix[]): number[] {
  if (track.length === 0) return [];
  const cum = new Array<number>(track.length);
  cum[0] = 0;
  for (let i = 1; i < track.length; i++) {
    cum[i] = cum[i - 1] + haversineMeters(track[i - 1], track[i]);
  }
  return cum;
}
