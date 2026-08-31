import type { Fix } from "../engine/types";
import { bearingBetween, relativeBearing } from "./nav";
import {
  estimateAdaptiveReturnSpeed,
  estimateTargetCourseSpeed,
  hasCoupledAcceleration,
} from "./returnSpeed";
import { haversineMeters } from "./stats";
import { sunsetNear } from "./sun";

const ONE_MILE_M = 1609.344;
const REARM_DISTANCE_M = ONE_MILE_M * 1.2;
const INBOUND_WINDOW_MS = 12_000;
const MEASURED_SPEED_WINDOW_MS = 5_000;
const NO_MODEL_CALIBRATION_WINDOW_MS = 10 * 60_000;
const CALIBRATION_MAX_AGE_MS = 30 * 60_000;
const CALIBRATION_FULL_ALTITUDE_DELTA_M = 100;
const CALIBRATION_MAX_ALTITUDE_DELTA_M = 500;
const CALIBRATION_FULL_COURSE_DELTA_DEGREES = 10;
const CALIBRATION_MAX_COURSE_DELTA_DEGREES = 45;
const CALIBRATION_MAX_ERROR_DEGREES = 10;
const TARGET_SPEED_FULL_COURSE_DELTA_DEGREES = 10;
const TARGET_SPEED_MAX_COURSE_DELTA_DEGREES = 20;
const SUNSET_LEAD_MS = 30 * 60 * 1000;
const MIN_NAV_SPEED_MPS = 5;
const MIN_CLOSING_SPEED_MPS = 3;
const ACQUIRE_ERROR_DEGREES = 30;
const HINT_MIN_DEGREES = 5;
const HINT_MAX_DEGREES = 20;
const MAX_TURN_RATE_DEGREES = 3;
const CORRECTING_DEGREES = 3;
const MAX_FIX_GAP_MS = 3000;
const MAX_HORIZONTAL_ACCURACY_M = 100;

export type NavigationTargetKind = "launch" | "waypoint";
export type DirectionHint = "left" | "right" | null;

export interface NavigationTarget {
  kind: NavigationTargetKind;
  latitude: number;
  longitude: number;
}

export interface NavigationGuidance {
  distanceMeters: number;
  directionDegrees: number;
  etaSeconds: number | null;
  sunsetAt: number | null;
  sunsetOffsetMs: number | null;
  arrivalSunsetOffsetMs: number | null;
  directionHint: DirectionHint;
}

function recentFixes(track: readonly Fix[], windowMs: number): Fix[] {
  const latest = track[track.length - 1];
  if (!latest) return [];
  const since = latest.timestamp - windowMs;
  return track.filter((fix) => fix.timestamp >= since);
}

function fixIsUsable(fix: Fix): boolean {
  const accuracy = fix.horizontalAccuracy;
  const accurate = accuracy === 0 || accuracy <= MAX_HORIZONTAL_ACCURACY_M;
  return accurate && fix.speed >= MIN_NAV_SPEED_MPS;
}

function gapsAreUsable(fixes: readonly Fix[]): boolean {
  for (let index = 1; index < fixes.length; index++) {
    if (fixes[index].timestamp - fixes[index - 1].timestamp > MAX_FIX_GAP_MS) {
      return false;
    }
  }
  return true;
}

function targetErrors(
  fixes: readonly Fix[],
  target: NavigationTarget,
): number[] {
  return fixes.map((fix) =>
    relativeBearing(fix.course, bearingBetween(fix, target)),
  );
}

function averageTurnRate(fixes: readonly Fix[]): number {
  let total = 0;
  for (let index = 1; index < fixes.length; index++) {
    total += Math.abs(
      relativeBearing(fixes[index - 1].course, fixes[index].course),
    );
  }
  const duration =
    (fixes[fixes.length - 1].timestamp - fixes[0].timestamp) / 1000;
  return duration > 0 ? total / duration : Number.POSITIVE_INFINITY;
}

function closingSpeed(fixes: readonly Fix[], target: NavigationTarget): number {
  const first = fixes[0];
  const latest = fixes[fixes.length - 1];
  const duration = (latest.timestamp - first.timestamp) / 1000;
  if (duration <= 0) return 0;
  return (
    (haversineMeters(first, target) - haversineMeters(latest, target)) /
    duration
  );
}

interface InboundState {
  closingMetersPerSecond: number;
  errors: number[];
  fixes: Fix[];
}

function inboundEndingAt(
  track: readonly Fix[],
  target: NavigationTarget,
  endIndex: number,
): InboundState | null {
  const end = track[endIndex];
  if (!end) return null;
  const since = end.timestamp - INBOUND_WINDOW_MS;
  let startIndex = endIndex;
  while (startIndex > 0 && track[startIndex - 1].timestamp >= since) {
    startIndex--;
  }
  const fixes = track.slice(startIndex, endIndex + 1);
  if (fixes.length < 2) return null;
  const duration = fixes[fixes.length - 1].timestamp - fixes[0].timestamp;
  if (duration < INBOUND_WINDOW_MS || !gapsAreUsable(fixes)) return null;
  if (!fixes.every(fixIsUsable)) return null;
  if (fixes.some((_, index) => hasCoupledAcceleration(fixes, index))) {
    return null;
  }
  const errors = targetErrors(fixes, target);
  if (errors.some((error) => Math.abs(error) > ACQUIRE_ERROR_DEGREES)) {
    return null;
  }
  const closingMetersPerSecond = closingSpeed(fixes, target);
  if (closingMetersPerSecond < MIN_CLOSING_SPEED_MPS) return null;
  return { closingMetersPerSecond, errors, fixes };
}

function stableInbound(
  track: readonly Fix[],
  target: NavigationTarget,
): InboundState | null {
  return inboundEndingAt(track, target, track.length - 1);
}

function currentClosingSpeed(
  track: readonly Fix[],
  targetCourse: number,
): number | null {
  const latest = track[track.length - 1];
  if (!latest || !fixIsUsable(latest)) return null;
  if (hasCoupledAcceleration(track, track.length - 1)) return null;
  const error = relativeBearing(latest.course, targetCourse);
  if (Math.abs(error) > ACQUIRE_ERROR_DEGREES) return null;
  const speed = latest.speed * Math.cos((error * Math.PI) / 180);
  return speed >= MIN_CLOSING_SPEED_MPS ? speed : null;
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[middle];
  return (ordered[middle - 1] + ordered[middle]) / 2;
}

function robustMean(values: readonly number[]): number {
  if (values.length < 5) return median(values);
  const ordered = [...values].sort((a, b) => a - b);
  const trimmed = ordered.slice(1, -1);
  return trimmed.reduce((sum, value) => sum + value, 0) / trimmed.length;
}

function measuredInboundSpeed(
  inbound: InboundState,
  target: NavigationTarget,
): number {
  const fixes = recentFixes(inbound.fixes, MEASURED_SPEED_WINDOW_MS);
  const speeds = fixes.map((fix) => {
    const targetCourse = bearingBetween(fix, target);
    const error = relativeBearing(fix.course, targetCourse);
    return fix.speed * Math.cos((error * Math.PI) / 180);
  });
  const measured = robustMean(speeds);
  return measured >= MIN_CLOSING_SPEED_MPS
    ? measured
    : inbound.closingMetersPerSecond;
}

interface InboundCalibration {
  inbound: InboundState;
  fix: Fix;
  targetCourse: number;
}

function isCalibrationInbound(inbound: InboundState): boolean {
  return inbound.errors.every(
    (error) => Math.abs(error) <= CALIBRATION_MAX_ERROR_DEGREES,
  );
}

function recentInboundCalibration(
  track: readonly Fix[],
  target: NavigationTarget,
): InboundCalibration | null {
  const latest = track[track.length - 1];
  if (!latest) return null;
  for (let endIndex = track.length - 2; endIndex >= 0; endIndex--) {
    const fix = track[endIndex];
    if (latest.timestamp - fix.timestamp > CALIBRATION_MAX_AGE_MS) return null;
    const inbound = inboundEndingAt(track, target, endIndex);
    if (!inbound || !isCalibrationInbound(inbound)) continue;
    return {
      inbound,
      fix,
      targetCourse: bearingBetween(fix, target),
    };
  }
  return null;
}

function decliningConfidence(
  value: number,
  fullUntil: number,
  noneAt: number,
): number {
  if (value <= fullUntil) return 1;
  if (value >= noneAt) return 0;
  return 1 - (value - fullUntil) / (noneAt - fullUntil);
}

function calibrationWeight(
  latest: Fix,
  currentTargetCourse: number,
  calibration: InboundCalibration,
  modelWindowMs: number,
): number {
  const age = latest.timestamp - calibration.fix.timestamp;
  const altitudeDelta = Math.abs(latest.altitude - calibration.fix.altitude);
  const courseDelta = Math.abs(
    relativeBearing(calibration.targetCourse, currentTargetCourse),
  );
  const ageConfidence = decliningConfidence(age, 0, modelWindowMs);
  const altitudeConfidence = decliningConfidence(
    altitudeDelta,
    CALIBRATION_FULL_ALTITUDE_DELTA_M,
    CALIBRATION_MAX_ALTITUDE_DELTA_M,
  );
  const courseConfidence = decliningConfidence(
    courseDelta,
    CALIBRATION_FULL_COURSE_DELTA_DEGREES,
    CALIBRATION_MAX_COURSE_DELTA_DEGREES,
  );
  return ageConfidence * altitudeConfidence * courseConfidence;
}

function targetSpeedWeight(
  latest: Fix,
  currentTargetCourse: number,
  estimate: {
    altitude: number;
    course: number;
    observedAt: number;
  },
  modelWindowMs: number,
): number {
  const ageConfidence = decliningConfidence(
    latest.timestamp - estimate.observedAt,
    0,
    modelWindowMs,
  );
  const altitudeConfidence = decliningConfidence(
    Math.abs(latest.altitude - estimate.altitude),
    CALIBRATION_FULL_ALTITUDE_DELTA_M,
    CALIBRATION_MAX_ALTITUDE_DELTA_M,
  );
  const courseConfidence = decliningConfidence(
    Math.abs(relativeBearing(estimate.course, currentTargetCourse)),
    TARGET_SPEED_FULL_COURSE_DELTA_DEGREES,
    TARGET_SPEED_MAX_COURSE_DELTA_DEGREES,
  );
  return ageConfidence * altitudeConfidence * courseConfidence;
}

function blendMeasuredSpeed(
  measured: number,
  model: number | null,
  measuredWeight: number,
): number {
  if (model === null) return measured;
  return measured * measuredWeight + model * (1 - measuredWeight);
}

function interpolate(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}

function returnSpeed(
  track: readonly Fix[],
  target: NavigationTarget,
  course: number,
): number | null {
  const model = estimateAdaptiveReturnSpeed(track, course);
  const inbound = stableInbound(track, target);
  if (inbound && isCalibrationInbound(inbound)) {
    const measured = measuredInboundSpeed(inbound, target);
    return blendMeasuredSpeed(
      measured,
      model?.conservativeMetersPerSecond ?? null,
      1,
    );
  }
  const latest = track[track.length - 1];
  const targetSpeed = estimateTargetCourseSpeed(track, course);
  if (targetSpeed && latest) {
    const modelWindowMs = model?.windowMs ?? NO_MODEL_CALIBRATION_WINDOW_MS;
    const weight = targetSpeedWeight(
      latest,
      course,
      targetSpeed,
      modelWindowMs,
    );
    if (weight > 0) {
      const modelSpeed = model?.conservativeMetersPerSecond ?? null;
      const selected = blendMeasuredSpeed(
        targetSpeed.metersPerSecond,
        modelSpeed,
        weight,
      );
      if (targetSpeed.previous) {
        const previousWeight = targetSpeedWeight(
          latest,
          course,
          targetSpeed.previous,
          modelWindowMs,
        );
        const previousSelected =
          previousWeight > 0
            ? blendMeasuredSpeed(
                targetSpeed.previous.metersPerSecond,
                modelSpeed,
                previousWeight,
              )
            : modelSpeed;
        if (previousSelected !== null) {
          return interpolate(
            previousSelected,
            selected,
            targetSpeed.transitionProgress,
          );
        }
      }
      return blendMeasuredSpeed(
        targetSpeed.metersPerSecond,
        modelSpeed,
        weight * targetSpeed.transitionProgress,
      );
    }
  }
  const calibration = recentInboundCalibration(track, target);
  if (calibration && latest) {
    const modelWindowMs = model?.windowMs ?? NO_MODEL_CALIBRATION_WINDOW_MS;
    const weight = calibrationWeight(
      latest,
      course,
      calibration,
      modelWindowMs,
    );
    if (weight > 0) {
      const measured = measuredInboundSpeed(calibration.inbound, target);
      return blendMeasuredSpeed(
        measured,
        model?.conservativeMetersPerSecond ?? null,
        weight,
      );
    }
  }
  if (inbound) {
    return model?.conservativeMetersPerSecond ?? inbound.closingMetersPerSecond;
  }
  return (
    model?.conservativeMetersPerSecond ?? currentClosingSpeed(track, course)
  );
}

function crossedRearmDistance(
  track: readonly Fix[],
  target: NavigationTarget,
): boolean {
  return track.some((fix) => haversineMeters(fix, target) >= REARM_DISTANCE_M);
}

function hintFromInbound(inbound: InboundState): DirectionHint {
  if (averageTurnRate(inbound.fixes) > MAX_TURN_RATE_DEGREES) return null;
  const firstError = Math.abs(inbound.errors[0]);
  const latestError = inbound.errors[inbound.errors.length - 1];
  if (firstError - Math.abs(latestError) >= CORRECTING_DEGREES) return null;
  const side = Math.sign(latestError);
  const persistent = inbound.errors.every((error) => {
    const magnitude = Math.abs(error);
    return (
      Math.sign(error) === side &&
      magnitude >= HINT_MIN_DEGREES &&
      magnitude <= HINT_MAX_DEGREES
    );
  });
  if (!persistent) {
    return null;
  }
  return latestError < 0 ? "left" : "right";
}

function directionHint(
  track: readonly Fix[],
  target: NavigationTarget,
  distanceMeters: number,
): DirectionHint {
  if (target.kind !== "launch" || distanceMeters <= ONE_MILE_M) return null;
  if (!crossedRearmDistance(track, target)) return null;
  const inbound = stableInbound(track, target);
  return inbound ? hintFromInbound(inbound) : null;
}

function relevantSunset(
  track: readonly Fix[],
  target: NavigationTarget,
): number | null {
  const first = track[0];
  const latest = track[track.length - 1];
  if (!first || !latest) return null;
  const candidates = [latest, first].map((fix) =>
    sunsetNear(
      new Date(fix.timestamp),
      target.latitude,
      target.longitude,
    )?.getTime(),
  );
  for (const sunset of candidates) {
    if (
      sunset &&
      first.timestamp <= sunset &&
      latest.timestamp >= sunset - SUNSET_LEAD_MS
    ) {
      return sunset;
    }
  }
  return null;
}

export function deriveNavigationGuidance(
  track: readonly Fix[],
  target: NavigationTarget,
): NavigationGuidance | null {
  const latest = track[track.length - 1];
  if (!latest) return null;
  const distanceMeters = haversineMeters(latest, target);
  const targetCourse = bearingBetween(latest, target);
  const directionDegrees = relativeBearing(latest.course, targetCourse);
  const speed = returnSpeed(track, target, targetCourse);
  const etaSeconds = speed ? distanceMeters / speed : null;
  const sunsetAt = relevantSunset(track, target);
  return {
    distanceMeters,
    directionDegrees,
    etaSeconds,
    sunsetAt,
    sunsetOffsetMs: sunsetAt ? latest.timestamp - sunsetAt : null,
    arrivalSunsetOffsetMs:
      sunsetAt && etaSeconds
        ? latest.timestamp + etaSeconds * 1000 - sunsetAt
        : null,
    directionHint: directionHint(track, target, distanceMeters),
  };
}
