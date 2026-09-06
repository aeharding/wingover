import type { Fix } from "../engine/types";
import { bearingBetween, relativeBearing } from "./nav";
import {
  estimateAdaptiveReturnSpeed,
  estimateTargetCourseSpeed,
  hasCoupledAcceleration,
  type ReturnSpeedEstimate,
  type TargetCourseSpeedEstimate,
} from "./returnSpeed";
import { haversineMeters } from "./stats";
import { sunsetNear } from "./sun";

const ONE_MILE_M = 1609.344;
const INBOUND_WINDOW_MS = 12_000;
const MEASURED_SPEED_WINDOW_MS = 5_000;
const CALIBRATION_MAX_AGE_MS = 30 * 60_000;
const CALIBRATION_FULL_ALTITUDE_DELTA_M = 100;
const CALIBRATION_MAX_ALTITUDE_DELTA_M = 500;
const CALIBRATION_FULL_COURSE_DELTA_DEGREES = 10;
const CALIBRATION_MAX_COURSE_DELTA_DEGREES = 45;
const CALIBRATION_MAX_ERROR_DEGREES = 10;
const TARGET_SPEED_FULL_COURSE_DELTA_DEGREES = 10;
const TARGET_SPEED_MAX_COURSE_DELTA_DEGREES = 20;
const SUNSET_LEAD_MS = 30 * 60 * 1000;
const SUNSET_TRAIL_MS = 60 * 60 * 1000;
const MIN_NAV_SPEED_MPS = 1;
const MIN_CLOSING_SPEED_MPS = 1;
const ACQUIRE_ERROR_DEGREES = 30;
const MAX_FIX_GAP_MS = 3000;
const MAX_HORIZONTAL_ACCURACY_M = 100;

export type NavigationTargetKind = "launch" | "waypoint";

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
}

export interface NavigationGuidanceDiagnostics {
  guidance: NavigationGuidance | null;
  model: ReturnSpeedEstimate | null;
  targetSpeed: TargetCourseSpeedEstimate | null;
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
  while (startIndex > 0 && track[startIndex].timestamp > since) {
    const gap = track[startIndex].timestamp - track[startIndex - 1].timestamp;
    if (gap > MAX_FIX_GAP_MS) break;
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
  model: ReturnSpeedEstimate | null,
  targetSpeed: TargetCourseSpeedEstimate | null,
): number | null {
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
  if (targetSpeed && latest) {
    const modelWindowMs = model?.windowMs ?? CALIBRATION_MAX_AGE_MS;
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
    const modelWindowMs = model?.windowMs ?? CALIBRATION_MAX_AGE_MS;
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

function relevantSunset(
  track: readonly Fix[],
  etaSeconds: number | null,
): number | null {
  const latest = track[track.length - 1];
  if (!latest) return null;
  const sunset = sunsetNear(
    new Date(latest.timestamp),
    latest.latitude,
    latest.longitude,
  )?.getTime();
  const arrivalAt = latest.timestamp + (etaSeconds ?? 0) * 1000;
  if (
    sunset &&
    arrivalAt >= sunset - SUNSET_LEAD_MS &&
    latest.timestamp <= sunset + SUNSET_TRAIL_MS
  ) {
    return sunset;
  }
  return null;
}

function deriveNavigationGuidanceDiagnostics(
  track: readonly Fix[],
  target: NavigationTarget,
  includeHiddenArrival: boolean,
): NavigationGuidanceDiagnostics {
  const latest = track[track.length - 1];
  if (!latest) return { guidance: null, model: null, targetSpeed: null };
  const distanceMeters = haversineMeters(latest, target);
  const targetCourse = bearingBetween(latest, target);
  const directionDegrees = relativeBearing(latest.course, targetCourse);
  const shouldEstimateLiveArrival =
    target.kind !== "launch" || distanceMeters > ONE_MILE_M;
  const shouldEstimateArrival =
    includeHiddenArrival || shouldEstimateLiveArrival;
  const model = shouldEstimateArrival
    ? estimateAdaptiveReturnSpeed(track, targetCourse)
    : null;
  const targetSpeed = shouldEstimateArrival
    ? estimateTargetCourseSpeed(track, target)
    : null;
  const speed = shouldEstimateArrival
    ? returnSpeed(track, target, targetCourse, model, targetSpeed)
    : null;
  const etaSeconds = speed ? distanceMeters / speed : null;
  const sunsetAt = relevantSunset(
    track,
    shouldEstimateLiveArrival ? etaSeconds : null,
  );
  return {
    guidance: {
      distanceMeters,
      directionDegrees,
      etaSeconds,
      sunsetAt,
      sunsetOffsetMs: sunsetAt ? latest.timestamp - sunsetAt : null,
      arrivalSunsetOffsetMs:
        sunsetAt && etaSeconds
          ? latest.timestamp + etaSeconds * 1000 - sunsetAt
          : null,
    },
    model,
    targetSpeed,
  };
}

export function deriveNavigationGuidance(
  track: readonly Fix[],
  target: NavigationTarget,
): NavigationGuidance | null {
  return deriveNavigationGuidanceDiagnostics(track, target, false).guidance;
}

export function deriveNavigationDiagnostics(
  track: readonly Fix[],
  target: NavigationTarget,
): NavigationGuidanceDiagnostics {
  return deriveNavigationGuidanceDiagnostics(track, target, true);
}
