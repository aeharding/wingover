import type { Fix } from "../engine/types";

// >10 mph triggers (Alex, 2026-07-10 device testing — PLAN question #2).
export const TAKEOFF_SPEED_MPS = 4.5;
export const TAKEOFF_SUSTAIN_FIXES = 5;
export const MOVEMENT_SPEED_MPS = 1.5;

export const MAX_HORIZONTAL_ACCURACY_M = 10;
export const MAX_VERTICAL_ACCURACY_M = 15;
export const ACCURACY_SUSTAIN_FIXES = 3;

// Takeoff detection only needs a credible speed, not survey-grade fixes:
// CoreLocation speed is doppler-derived and trustworthy well past the
// arming gate's bounds, and accuracy routinely degrades in motion (found
// on-device 2026-07-10: armed ground test at 15+ mph never triggered —
// isAccurate() fixes reset the sustain run while the UI showed speed).
// The bound still rejects wifi/cell junk (±50m+), which is what keeps
// desktops from recording "flights". Vertical accuracy is irrelevant to
// whether we are moving, so it plays no part here — the strict two-axis
// gate remains for arming (gpsReadyIndex).
export const MAX_SPEED_ACCURACY_M = 35;

export function isAccurate(fix: Fix): boolean {
  return (
    fix.horizontalAccuracy <= MAX_HORIZONTAL_ACCURACY_M &&
    fix.verticalAccuracy <= MAX_VERTICAL_ACCURACY_M
  );
}

function hasCredibleSpeed(fix: Fix): boolean {
  return fix.horizontalAccuracy <= MAX_SPEED_ACCURACY_M;
}

// Reduced-accuracy sources (iOS Precise Location off) sit kilometers
// coarse indefinitely (observed 13 km+ in Safari); real GPS converges
// far below this within seconds of sky view, and even cell
// triangulation lands under ~2 km. Sustained gross coarseness is a
// source-level problem, not a slow first fix.
export const IMPRECISE_M = 2000;
export const IMPRECISE_SUSTAIN_MS = 12_000;

// The reduced-accuracy signature: kilometer-coarse horizontal AND no
// altitude solution at all. Cell-triangulated cold-start fixes are coarse
// but sit under ~2 km; anything GPS-assisted has an altitude. Judged per
// fix, not per run: with Precise Location off the browser pins to a grid
// tile and may deliver ONE fix then go silent, so the web source latches
// on wall clock (IMPRECISE_SUSTAIN_MS), not on a count of arrivals.
// Reads raw source coordinates, before Fix normalization (a null
// altitudeAccuracy is no altitude solution).
export function coordsLookReduced(coords: {
  accuracy: number;
  altitudeAccuracy: number | null;
}): boolean {
  return (
    coords.accuracy > IMPRECISE_M &&
    !Number.isFinite(coords.altitudeAccuracy ?? Number.POSITIVE_INFINITY)
  );
}

export function gpsReadyIndex(track: Fix[]): number | null {
  let run = 0;
  for (let i = 0; i < track.length; i++) {
    run = isAccurate(track[i]) ? run + 1 : 0;
    if (run >= ACCURACY_SUSTAIN_FIXES) return i;
  }
  return null;
}

export function detectTakeoff(track: Fix[]): number | null {
  let run = 0;
  for (let i = 0; i < track.length; i++) {
    const fix = track[i];
    run = hasCredibleSpeed(fix) && fix.speed >= TAKEOFF_SPEED_MPS ? run + 1 : 0;
    if (run >= TAKEOFF_SUSTAIN_FIXES) {
      let start = i - run + 1;
      while (
        start > 0 &&
        hasCredibleSpeed(track[start - 1]) &&
        track[start - 1].speed >= MOVEMENT_SPEED_MPS
      )
        start--;
      return start;
    }
  }
  return null;
}
