import type { Fix } from "../engine/types";
import { haversineMeters } from "./stats";

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

// Speed alone false-positived on a real flight (Alex, 2026-08): winds
// aloft at altitude held ground speed under 2 m/s while the pilot flew
// high above launch, and a windy final approach does the same while
// descending. So a landing must also LOOK like the launch site: near
// it, at its elevation, and no longer changing altitude. Chosen bounds
// (Alex, 2026-08-16), not calibrated ones: generous enough for any
// same-field landing, and a land-out away from launch deliberately
// never auto-detects — it waits for the pilot's Stop, recording too
// long rather than ending a flight still in the air (STEERING:
// recording never loses a flight).
export const LANDING_RADIUS_M = 275; // ~900 ft horizontally from launch
export const LANDING_ALTITUDE_M = 45; // ~150 ft above/below launch
// The window spans 14 one-second intervals, so this bound rejects any
// descent steadier than ~0.7 m/s sustained across it; both real
// reference flights hold a <2 m band while parked (measured 2026-08-16,
// vs 11.7 m p99 single-fix steps aloft on the noisier of them). GPS
// altitude only — baro (ARCHITECTURE open question) is the upgrade
// path if a device's vertical solution proves too noisy to ever pass.
export const LANDING_ALTITUDE_DRIFT_M = 10;

function nearLaunch(fix: Fix, launch: Fix): boolean {
  return (
    haversineMeters(fix, launch) <= LANDING_RADIUS_M &&
    Math.abs(fix.altitude - launch.altitude) <= LANDING_ALTITUDE_M
  );
}

// The recorded track only exists after sustained takeoff speed, so a
// trailing run of near-zero ground speed at the launch point, at launch
// elevation, holding altitude, can almost only mean the wing is down.
// The residual is a sustained wind-hover BELOW the altitude band — which
// is why detection prompts instead of auto-stopping, and why "Still
// flying" silences it for the rest of the flight. `launch` is the
// backdated ground-roll fix (buffer[takeoffIndex]), not the plan's pin;
// a source with no altitude solution repeats its last altitude
// (engine toFix), which degrades the two altitude criteria to
// always-true and this to the speed+radius rule.
// Every criterion must hold for the whole sustain window.
export function isLanded(track: Fix[], launch: Fix): boolean {
  if (track.length < LANDING_SUSTAIN_FIXES) return false;
  let lowest = Number.POSITIVE_INFINITY;
  let highest = Number.NEGATIVE_INFINITY;
  for (let i = track.length - LANDING_SUSTAIN_FIXES; i < track.length; i++) {
    const fix = track[i];
    if (fix.speed > LANDING_SPEED_MPS) return false;
    if (!nearLaunch(fix, launch)) return false;
    lowest = Math.min(lowest, fix.altitude);
    highest = Math.max(highest, fix.altitude);
  }
  return highest - lowest <= LANDING_ALTITUDE_DRIFT_M;
}
