import type { Fix } from "../engine/types";

// >10 mph triggers (Alex, 2026-07-10 device testing — PLAN question #2).
export const TAKEOFF_SPEED_MPS = 4.5;
export const TAKEOFF_SUSTAIN_FIXES = 5;
export const MOVEMENT_SPEED_MPS = 1.5;

export const MAX_HORIZONTAL_ACCURACY_M = 10;
export const MAX_VERTICAL_ACCURACY_M = 15;
export const ACCURACY_SUSTAIN_FIXES = 3;

export function isAccurate(fix: Fix): boolean {
  return (
    fix.horizontalAccuracy <= MAX_HORIZONTAL_ACCURACY_M &&
    fix.verticalAccuracy <= MAX_VERTICAL_ACCURACY_M
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
    run = isAccurate(fix) && fix.speed >= TAKEOFF_SPEED_MPS ? run + 1 : 0;
    if (run >= TAKEOFF_SUSTAIN_FIXES) {
      let start = i - run + 1;
      while (
        start > 0 &&
        isAccurate(track[start - 1]) &&
        track[start - 1].speed >= MOVEMENT_SPEED_MPS
      )
        start--;
      return start;
    }
  }
  return null;
}
