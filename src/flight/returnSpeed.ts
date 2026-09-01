import type { Fix } from "../engine/types";
import { bearingBetween } from "./nav";

const DEFAULT_WINDOW_MS = 30 * 60 * 1000;
const HEADING_BIN_DEGREES = 15;
const HEADING_BIN_FULL_SUPPORT_SECONDS = 6;
const MAX_FIX_SUPPORT_SECONDS = 1;
const WINDOW_FADE_FRACTION = 0.1;
const MIN_SAMPLE_SPEED_MPS = 1;
const MIN_AIRSPEED_MPS = 5;
const MAX_SPEED_MPS = 40;
const MIN_CONSERVATIVE_SPEED_MPS = 1;
const MIN_HEADING_SPAN = 90;
const MINUTE_MS = 60_000;
const ADAPTIVE_WINDOWS_MS = [5, 10, 15, 30].map(
  (minutes) => minutes * MINUTE_MS,
);
const MAX_TURN_RATE_DEGREES = 5;
const MAX_CLIMB_RATE_MPS = 3;
const MAX_SPEED_ACCELERATION_MPS2 = 2;
const MAX_VERTICAL_ACCELERATION_MPS2 = 1.5;
const MANEUVER_COUPLING_WINDOW_MS = 2000;
const SHORT_MODEL_MAX_SENSITIVITY_MPS = 2;
const SHORT_MODEL_CONFIDENCE_SCALE_MPS = 2;
const TEN_MINUTE_MODEL_WEIGHT = 0.35;
const FIFTEEN_MINUTE_MODEL_WEIGHT = 0.15;
const THIRTY_MINUTE_MODEL_WEIGHT = 0.5;
const ALTITUDE_FULL_WEIGHT_DELTA_M = 100;
const ALTITUDE_ZERO_WEIGHT_DELTA_M = 500;
const TARGET_COURSE_MAX_AGE_MS = 30 * MINUTE_MS;
const TARGET_COURSE_MAX_ERROR_DEGREES = 15;
const TARGET_COURSE_MAX_GAP_MS = 3000;
const TARGET_COURSE_MAX_TURN_RATE_DEGREES = 3;
const TARGET_COURSE_MAX_SPEED_ACCELERATION_MPS2 = 3;
const TARGET_COURSE_MAX_VERTICAL_ACCELERATION_MPS2 = 2.5;
const TARGET_COURSE_MIN_DURATION_MS = 2000;
const TARGET_COURSE_MIN_SAMPLES = 3;
const TARGET_COURSE_SPEED_WINDOW_MS = 5000;
const TARGET_COURSE_FULL_CONFIDENCE_MS = 6000;

interface Velocity {
  east: number;
  north: number;
  course: number;
}

interface WeightedVelocity extends Velocity {
  weight: number;
}

interface ReturnTarget {
  latitude: number;
  longitude: number;
}

interface Circle {
  coefficients: Vector3;
  covariance: Matrix3;
  east: number;
  north: number;
  radius: number;
  residual: number;
}

type Vector3 = [number, number, number];
type Matrix3 = [Vector3, Vector3, Vector3];

export interface ReturnSpeedEstimate {
  metersPerSecond: number;
  conservativeMetersPerSecond: number;
  windEast: number;
  windNorth: number;
  airspeed: number;
  residual: number;
  headingSpan: number;
  sampleCount: number;
  sensitivity: number;
  windowMs: number;
}

export interface TargetCourseSpeedSample {
  altitude: number;
  course: number;
  metersPerSecond: number;
  observedAt: number;
  sampleCount: number;
}

export interface TargetCourseSpeedEstimate extends TargetCourseSpeedSample {
  previous: TargetCourseSpeedSample | null;
  transitionProgress: number;
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

function decliningConfidence(
  value: number,
  fullUntil: number,
  noneAt: number,
): number {
  if (value <= fullUntil) return 1;
  if (value >= noneAt) return 0;
  return 1 - (value - fullUntil) / (noneAt - fullUntil);
}

function weightedMean(
  samples: readonly WeightedVelocity[],
  select: (sample: WeightedVelocity) => number,
): number {
  const totalWeight = samples.reduce((sum, sample) => sum + sample.weight, 0);
  return (
    samples.reduce((sum, sample) => sum + select(sample) * sample.weight, 0) /
    totalWeight
  );
}

function velocity(fix: Fix): Velocity {
  const radians = (fix.course * Math.PI) / 180;
  return {
    east: fix.speed * Math.sin(radians),
    north: fix.speed * Math.cos(radians),
    course: fix.course,
  };
}

function fixSupportSeconds(fixes: readonly Fix[], index: number): number {
  const previous = fixes[index - 1];
  const next = fixes[index + 1];
  let gapMs = 1000;
  if (previous) gapMs = fixes[index].timestamp - previous.timestamp;
  else if (next) gapMs = next.timestamp - fixes[index].timestamp;
  return Math.min(MAX_FIX_SUPPORT_SECONDS, Math.max(0, gapMs / 1000));
}

function binVelocities(
  fixes: readonly Fix[],
  altitude: number,
  latestTimestamp: number,
  windowMs: number,
): WeightedVelocity[] {
  const bins = new Map<number, WeightedVelocity[]>();
  for (let index = 0; index < fixes.length; index++) {
    const fix = fixes[index];
    if (fix.speed < MIN_SAMPLE_SPEED_MPS || fix.speed > MAX_SPEED_MPS) continue;
    if (fix.horizontalAccuracy > 100) continue;
    const altitudeWeight = decliningConfidence(
      Math.abs(fix.altitude - altitude),
      ALTITUDE_FULL_WEIGHT_DELTA_M,
      ALTITUDE_ZERO_WEIGHT_DELTA_M,
    );
    const age = latestTimestamp - fix.timestamp;
    const windowWeight = decliningConfidence(
      age,
      windowMs * (1 - WINDOW_FADE_FRACTION),
      windowMs,
    );
    const weight =
      altitudeWeight * windowWeight * fixSupportSeconds(fixes, index);
    if (weight <= 0) continue;
    const key = Math.floor(fix.course / HEADING_BIN_DEGREES);
    const samples = bins.get(key) ?? [];
    samples.push({ ...velocity(fix), weight });
    bins.set(key, samples);
  }
  return [...bins.values()].map((samples) => {
    const support = samples.reduce((sum, sample) => sum + sample.weight, 0);
    const supportProgress = Math.min(
      1,
      support / HEADING_BIN_FULL_SUPPORT_SECONDS,
    );
    return {
      east: weightedMean(samples, (sample) => sample.east),
      north: weightedMean(samples, (sample) => sample.north),
      course: weightedMean(samples, (sample) => sample.course),
      weight: supportProgress * supportProgress,
    };
  });
}

function headingSpan(samples: readonly Velocity[]): number {
  const headings = samples
    .map((sample) => ((sample.course % 360) + 360) % 360)
    .sort((a, b) => a - b);
  if (headings.length < 2) return 0;
  let largestGap = headings[0] + 360 - headings[headings.length - 1];
  for (let index = 1; index < headings.length; index++) {
    largestGap = Math.max(largestGap, headings[index] - headings[index - 1]);
  }
  return 360 - largestGap;
}

function invertMatrix3(matrix: Matrix3): Matrix3 | null {
  const [[a, b, c], [d, e, f], [g, h, i]] = matrix;
  const determinant =
    a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(determinant) < 1e-9) return null;
  return [
    [e * i - f * h, c * h - b * i, b * f - c * e],
    [f * g - d * i, a * i - c * g, c * d - a * f],
    [d * h - e * g, b * g - a * h, a * e - b * d],
  ].map((row) => row.map((value) => value / determinant)) as Matrix3;
}

function multiplyMatrixVector(matrix: Matrix3, vector: Vector3): Vector3 {
  return matrix.map((row) =>
    row.reduce((sum, value, index) => sum + value * vector[index], 0),
  ) as Vector3;
}

function fitCircle(samples: readonly WeightedVelocity[]): Circle | null {
  if (samples.length < 6) return null;
  const normal: Matrix3 = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const right: Vector3 = [0, 0, 0];
  for (const sample of samples) {
    const row: Vector3 = [sample.east, sample.north, 1];
    const squaredSpeed =
      sample.east * sample.east + sample.north * sample.north;
    for (let column = 0; column < 3; column++) {
      right[column] += sample.weight * row[column] * squaredSpeed;
      for (let other = 0; other < 3; other++) {
        normal[column][other] += sample.weight * row[column] * row[other];
      }
    }
  }
  const inverse = invertMatrix3(normal);
  if (!inverse) return null;
  const coefficients = multiplyMatrixVector(inverse, right);
  const east = coefficients[0] / 2;
  const north = coefficients[1] / 2;
  const radiusSquared = coefficients[2] + east * east + north * north;
  if (radiusSquared <= 0) return null;
  const radius = Math.sqrt(radiusSquared);
  const residual = weightedMean(samples, (sample) =>
    Math.abs(Math.hypot(sample.east - east, sample.north - north) - radius),
  );
  const algebraicError = weightedMean(samples, (sample) => {
    const predicted =
      coefficients[0] * sample.east +
      coefficients[1] * sample.north +
      coefficients[2];
    const observed = sample.east * sample.east + sample.north * sample.north;
    const error = observed - predicted;
    return error * error;
  });
  const covariance = inverse.map((row) =>
    row.map((value) => value * algebraicError),
  ) as Matrix3;
  return { coefficients, covariance, east, north, radius, residual };
}

function robustCircle(samples: readonly WeightedVelocity[]): Circle | null {
  const initial = fitCircle(samples);
  if (!initial) return null;
  const deviations = samples.map((sample) =>
    Math.abs(
      Math.hypot(sample.east - initial.east, sample.north - initial.north) -
        initial.radius,
    ),
  );
  const limit = Math.max(
    1.25,
    (deviations.reduce(
      (sum, deviation, index) => sum + deviation * samples[index].weight,
      0,
    ) /
      samples.reduce((sum, sample) => sum + sample.weight, 0)) *
      3,
  );
  const reweighted = samples.map((sample, index) => ({
    ...sample,
    weight:
      sample.weight * Math.min(1, limit / Math.max(limit, deviations[index])),
  }));
  return fitCircle(reweighted) ?? initial;
}

function projectedSpeed(circle: Circle, course: number): number | null {
  const radians = (course * Math.PI) / 180;
  const east = Math.sin(radians);
  const north = Math.cos(radians);
  const along = circle.east * east + circle.north * north;
  const cross = circle.east * north - circle.north * east;
  const airAlongSquared = circle.radius * circle.radius - cross * cross;
  if (airAlongSquared <= 0) return null;
  const speed = along + Math.sqrt(airAlongSquared);
  if (speed < MIN_CONSERVATIVE_SPEED_MPS || speed > MAX_SPEED_MPS) return null;
  return speed;
}

function modelSensitivity(circle: Circle, course: number): number {
  const radians = (course * Math.PI) / 180;
  const courseEast = Math.sin(radians);
  const courseNorth = Math.cos(radians);
  const along = circle.east * courseEast + circle.north * courseNorth;
  const root = Math.sqrt(circle.coefficients[2] + along * along);
  if (!Number.isFinite(root) || root <= 0) {
    return SHORT_MODEL_MAX_SENSITIVITY_MPS;
  }
  const alongScale = 1 + along / root;
  const gradient: Vector3 = [
    (courseEast * alongScale) / 2,
    (courseNorth * alongScale) / 2,
    1 / (2 * root),
  ];
  let variance = 0;
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      variance +=
        gradient[row] * circle.covariance[row][column] * gradient[column];
    }
  }
  return Math.sqrt(Math.max(0, variance));
}

function returnSpeedCandidate(
  fixes: readonly Fix[],
  targetCourse: number,
  windowMs = DEFAULT_WINDOW_MS,
): ReturnSpeedEstimate | null {
  const latest = fixes[fixes.length - 1];
  if (!latest) return null;
  const since = latest.timestamp - windowMs;
  const samples = binVelocities(
    fixes.filter((fix) => fix.timestamp >= since),
    latest.altitude,
    latest.timestamp,
    windowMs,
  );
  const span = headingSpan(samples);
  if (span < MIN_HEADING_SPAN) return null;
  const circle = robustCircle(samples);
  if (!circle || circle.residual > 3 || circle.radius < MIN_AIRSPEED_MPS) {
    return null;
  }
  const speed = projectedSpeed(circle, targetCourse);
  if (!speed) return null;
  const sensitivity = modelSensitivity(circle, targetCourse);
  const uncertainty = Math.max(0.75, circle.residual * 1.5);
  return {
    metersPerSecond: speed,
    conservativeMetersPerSecond: Math.max(
      MIN_CONSERVATIVE_SPEED_MPS,
      speed - uncertainty,
    ),
    windEast: circle.east,
    windNorth: circle.north,
    airspeed: circle.radius,
    residual: circle.residual,
    headingSpan: span,
    sampleCount: samples.length,
    sensitivity,
    windowMs,
  };
}

export function estimateReturnSpeed(
  fixes: readonly Fix[],
  targetCourse: number,
  windowMs = DEFAULT_WINDOW_MS,
): ReturnSpeedEstimate | null {
  const candidate = returnSpeedCandidate(fixes, targetCourse, windowMs);
  if (!candidate || candidate.sensitivity >= SHORT_MODEL_MAX_SENSITIVITY_MPS) {
    return null;
  }
  return candidate;
}

function relativeBearing(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

function turnRate(fixes: readonly Fix[], index: number): number {
  const fix = fixes[index];
  const previous = fixes[index - 1];
  if (!previous) return 0;
  const seconds = (fix.timestamp - previous.timestamp) / 1000;
  if (seconds <= 0) return Number.POSITIVE_INFINITY;
  return Math.abs(relativeBearing(previous.course, fix.course)) / seconds;
}

function rateOfChange(
  fixes: readonly Fix[],
  index: number,
  field: "speed" | "climbRate",
): number {
  const fix = fixes[index];
  const previous = fixes[index - 1];
  if (!previous) return 0;
  const seconds = (fix.timestamp - previous.timestamp) / 1000;
  if (seconds <= 0) return Number.POSITIVE_INFINITY;
  return Math.abs(fix[field] - previous[field]) / seconds;
}

function isAcceleratingManeuver(
  fixes: readonly Fix[],
  index: number,
  maximumSpeedAcceleration: number,
  maximumVerticalAcceleration: number,
): boolean {
  const timestamp = fixes[index].timestamp;
  let speedChanged = false;
  let verticalChanged = false;
  for (let nearby = index; nearby >= 0; nearby--) {
    if (timestamp - fixes[nearby].timestamp > MANEUVER_COUPLING_WINDOW_MS)
      break;
    speedChanged ||=
      rateOfChange(fixes, nearby, "speed") > maximumSpeedAcceleration;
    verticalChanged ||=
      rateOfChange(fixes, nearby, "climbRate") > maximumVerticalAcceleration;
  }
  return speedChanged && verticalChanged;
}

export function hasCoupledAcceleration(
  fixes: readonly Fix[],
  index: number,
): boolean {
  return isAcceleratingManeuver(
    fixes,
    index,
    MAX_SPEED_ACCELERATION_MPS2,
    MAX_VERTICAL_ACCELERATION_MPS2,
  );
}

function isDynamic(fixes: readonly Fix[], index: number): boolean {
  const fix = fixes[index];
  if (Math.abs(fix.climbRate) > MAX_CLIMB_RATE_MPS) return true;
  return (
    turnRate(fixes, index) > MAX_TURN_RATE_DEGREES ||
    hasCoupledAcceleration(fixes, index)
  );
}

function stableFixes(fixes: readonly Fix[]): Fix[] {
  return fixes.map((fix, index) => {
    if (!isDynamic(fixes, index)) return fix;
    return { ...fix, horizontalAccuracy: 101 };
  });
}

function targetCourseFixIsUsable(
  fixes: readonly Fix[],
  index: number,
  target: number | ReturnTarget,
): boolean {
  const fix = fixes[index];
  const targetCourse = courseToTarget(fix, target);
  return (
    fix.speed >= MIN_SAMPLE_SPEED_MPS &&
    fix.speed <= MAX_SPEED_MPS &&
    fix.horizontalAccuracy <= 100 &&
    Math.abs(fix.climbRate) <= MAX_CLIMB_RATE_MPS &&
    turnRate(fixes, index) <= TARGET_COURSE_MAX_TURN_RATE_DEGREES &&
    !isAcceleratingManeuver(
      fixes,
      index,
      TARGET_COURSE_MAX_SPEED_ACCELERATION_MPS2,
      TARGET_COURSE_MAX_VERTICAL_ACCELERATION_MPS2,
    ) &&
    Math.abs(relativeBearing(fix.course, targetCourse)) <=
      TARGET_COURSE_MAX_ERROR_DEGREES
  );
}

function targetCourseEstimate(
  samples: readonly Fix[],
  target: number | ReturnTarget,
): TargetCourseSpeedSample | null {
  if (samples.length < TARGET_COURSE_MIN_SAMPLES) return null;
  const duration = samples[samples.length - 1].timestamp - samples[0].timestamp;
  if (duration < TARGET_COURSE_MIN_DURATION_MS) return null;
  const observedAt = samples[samples.length - 1].timestamp;
  const recent = samples.filter(
    (fix) => fix.timestamp >= observedAt - TARGET_COURSE_SPEED_WINDOW_MS,
  );
  const courseError = median(
    recent.map((fix) =>
      relativeBearing(courseToTarget(fix, target), fix.course),
    ),
  );
  const observedTargetCourse = courseToTarget(
    recent[recent.length - 1],
    target,
  );
  return {
    altitude: median(recent.map((fix) => fix.altitude)),
    course: (observedTargetCourse + courseError + 360) % 360,
    metersPerSecond: robustMean(recent.map((fix) => fix.speed)),
    observedAt,
    sampleCount: recent.length,
  };
}

export function estimateTargetCourseSpeed(
  fixes: readonly Fix[],
  target: number | ReturnTarget,
): TargetCourseSpeedEstimate | null {
  const latest = fixes[fixes.length - 1];
  if (!latest) return null;
  const since = latest.timestamp - TARGET_COURSE_MAX_AGE_MS;
  const encounters: {
    durationMs: number;
    sample: TargetCourseSpeedSample;
  }[] = [];
  let samples: Fix[] = [];

  const finishEncounter = () => {
    const sample = targetCourseEstimate(samples, target);
    if (sample) {
      encounters.push({
        durationMs:
          samples[samples.length - 1].timestamp - samples[0].timestamp,
        sample,
      });
    }
    samples = [];
  };

  for (let index = fixes.length - 1; index >= 0; index--) {
    const fix = fixes[index];
    if (fix.timestamp < since) break;
    const next = samples[0];
    const fixIsUsable = targetCourseFixIsUsable(fixes, index, target);
    const gapIsUsable =
      !next || next.timestamp - fix.timestamp <= TARGET_COURSE_MAX_GAP_MS;
    if (fixIsUsable && gapIsUsable) {
      samples.unshift(fix);
      continue;
    }
    finishEncounter();
    if (encounters.length === 2) break;
    if (fixIsUsable) samples = [fix];
  }
  if (encounters.length < 2) finishEncounter();
  const current = encounters[0];
  if (!current) return null;
  return {
    ...current.sample,
    previous: encounters[1]?.sample ?? null,
    transitionProgress: Math.min(
      1,
      current.durationMs / TARGET_COURSE_FULL_CONFIDENCE_MS,
    ),
  };
}

function courseToTarget(fix: Fix, target: number | ReturnTarget): number {
  return typeof target === "number" ? target : bearingBetween(fix, target);
}

function weightedAverageModel(
  weightedModels: readonly {
    model: ReturnSpeedEstimate;
    weight: number;
  }[],
): ReturnSpeedEstimate {
  const totalWeight = weightedModels.reduce(
    (sum, candidate) => sum + candidate.weight,
    0,
  );
  const field = (select: (model: ReturnSpeedEstimate) => number) =>
    weightedModels.reduce(
      (sum, candidate) => sum + select(candidate.model) * candidate.weight,
      0,
    ) / totalWeight;
  return {
    metersPerSecond: field((model) => model.metersPerSecond),
    conservativeMetersPerSecond: field(
      (model) => model.conservativeMetersPerSecond,
    ),
    windEast: field((model) => model.windEast),
    windNorth: field((model) => model.windNorth),
    airspeed: field((model) => model.airspeed),
    residual: field((model) => model.residual),
    headingSpan: field((model) => model.headingSpan),
    sampleCount: field((model) => model.sampleCount),
    sensitivity: field((model) => model.sensitivity),
    windowMs: field((model) => model.windowMs),
  };
}

function shortModelConfidence(model: ReturnSpeedEstimate): number {
  const scaled = model.sensitivity / SHORT_MODEL_CONFIDENCE_SCALE_MPS;
  return 1 / (1 + scaled * scaled * scaled * scaled);
}

function reliableShortModel(
  candidate: ReturnSpeedEstimate | null,
  longModel: ReturnSpeedEstimate,
): ReturnSpeedEstimate {
  if (!candidate) return longModel;
  const confidence = shortModelConfidence(candidate);
  return weightedAverageModel([
    { model: candidate, weight: confidence },
    { model: longModel, weight: 1 - confidence },
  ]);
}

function rawAdaptiveReturnSpeed(
  stable: readonly Fix[],
  targetCourse: number,
): ReturnSpeedEstimate | null {
  const longModel = estimateReturnSpeed(
    stable,
    targetCourse,
    ADAPTIVE_WINDOWS_MS[3],
  );
  if (!longModel) return null;
  const tenMinute = reliableShortModel(
    returnSpeedCandidate(stable, targetCourse, ADAPTIVE_WINDOWS_MS[1]),
    longModel,
  );
  const fifteenMinute = reliableShortModel(
    returnSpeedCandidate(stable, targetCourse, ADAPTIVE_WINDOWS_MS[2]),
    longModel,
  );
  return {
    ...weightedAverageModel([
      { model: tenMinute, weight: TEN_MINUTE_MODEL_WEIGHT },
      { model: fifteenMinute, weight: FIFTEEN_MINUTE_MODEL_WEIGHT },
      { model: longModel, weight: THIRTY_MINUTE_MODEL_WEIGHT },
    ]),
    windowMs: DEFAULT_WINDOW_MS,
  };
}

export function estimateAdaptiveReturnSpeed(
  fixes: readonly Fix[],
  targetCourse: number,
): ReturnSpeedEstimate | null {
  const latest = fixes[fixes.length - 1];
  if (!latest) return null;
  const since = latest.timestamp - DEFAULT_WINDOW_MS;
  const stable = stableFixes(fixes.filter((fix) => fix.timestamp >= since));
  return rawAdaptiveReturnSpeed(stable, targetCourse);
}
