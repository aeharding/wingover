import type { Fix } from "../engine/types";

export const LANDING_SPEED_MPS = 1.0;
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
