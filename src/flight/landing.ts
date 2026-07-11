import type { Fix } from "../engine/types";

// Above walking pace, below any flying speed. Calibrated against five
// real flights (Alex, 2026-07-10/11): the packing-up walk medians
// ~1.2 m/s with bursts to 2.0 — a 1.0 threshold never completed the
// sustain window and the whole walk-around polluted the flight of
// record. At 2.5, detection fired at the earliest possible fix on the
// problem flight with zero false detections across 5.5 h of flying.
// Walking also can no longer UN-detect a landing; only genuinely moving
// off (>2.5 m/s) clears it.
export const LANDING_SPEED_MPS = 2.5;
export const LANDING_SUSTAIN_FIXES = 15;
// Fix-time (not wall-clock) grace between touchdown detection and
// auto-finalization, so a backlogged landing finalizes retroactively on
// replay exactly as it would have live.
export const LANDING_GRACE_MS = 30_000;

// The recorded track only exists after sustained takeoff speed, so a
// trailing run of near-zero ground speed can only mean the wing is down
// (or a rare stationary wind-hover — which is why landing prompts instead
// of auto-stopping).
export function isLanded(track: Fix[]): boolean {
  if (track.length < LANDING_SUSTAIN_FIXES) return false;
  for (let i = track.length - LANDING_SUSTAIN_FIXES; i < track.length; i++) {
    if (track[i].speed > LANDING_SPEED_MPS) return false;
  }
  return true;
}
