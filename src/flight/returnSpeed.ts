import type { Fix } from "../engine/types";

const DEFAULT_WINDOW_MS = 30 * 60 * 1000;
const HEADING_BIN_DEGREES = 15;
const MIN_SPEED_MPS = 5;
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
const SHORT_MODEL_FULL_HEADING_SPAN = 135;
const SHORT_MODEL_FULL_SENSITIVITY_MPS = 0.5;
const SHORT_MODEL_MAX_SENSITIVITY_MPS = 2;
const ALTITUDE_FULL_WEIGHT_DELTA_M = 100;
const ALTITUDE_ZERO_WEIGHT_DELTA_M = 500;
const SHORT_MODEL_CONFIRMATION_FIX_COUNT = 20;
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

interface Circle {
  east: number;
  north: number;
  radius: number;
  residual: number;
}

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

function increasingConfidence(
  value: number,
  noneUntil: number,
  fullAt: number,
) {
  return 1 - decliningConfidence(value, noneUntil, fullAt);
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

function binVelocities(fixes: readonly Fix[], altitude: number): Velocity[] {
  const bins = new Map<number, WeightedVelocity[]>();
  for (const fix of fixes) {
    if (fix.speed < MIN_SPEED_MPS || fix.speed > MAX_SPEED_MPS) continue;
    if (fix.horizontalAccuracy > 100) continue;
    const weight = decliningConfidence(
      Math.abs(fix.altitude - altitude),
      ALTITUDE_FULL_WEIGHT_DELTA_M,
      ALTITUDE_ZERO_WEIGHT_DELTA_M,
    );
    if (weight <= 0) continue;
    const key = Math.floor(fix.course / HEADING_BIN_DEGREES);
    const samples = bins.get(key) ?? [];
    samples.push({ ...velocity(fix), weight });
    bins.set(key, samples);
  }
  return [...bins.values()].map((samples) => ({
    east: weightedMean(samples, (sample) => sample.east),
    north: weightedMean(samples, (sample) => sample.north),
    course: weightedMean(samples, (sample) => sample.course),
  }));
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

function fitCircle(samples: readonly Velocity[]): Circle | null {
  if (samples.length < 6) return null;
  const meanEast =
    samples.reduce((sum, sample) => sum + sample.east, 0) / samples.length;
  const meanNorth =
    samples.reduce((sum, sample) => sum + sample.north, 0) / samples.length;
  let eastSquared = 0;
  let northSquared = 0;
  let eastNorth = 0;
  let eastRadius = 0;
  let northRadius = 0;
  for (const sample of samples) {
    const east = sample.east - meanEast;
    const north = sample.north - meanNorth;
    const radiusSquared = east * east + north * north;
    eastSquared += east * east;
    northSquared += north * north;
    eastNorth += east * north;
    eastRadius += east * radiusSquared;
    northRadius += north * radiusSquared;
  }
  const determinant = eastSquared * northSquared - eastNorth * eastNorth;
  if (Math.abs(determinant) < 0.001) return null;
  const centerEast =
    meanEast +
    (eastRadius * northSquared - northRadius * eastNorth) / (2 * determinant);
  const centerNorth =
    meanNorth +
    (northRadius * eastSquared - eastRadius * eastNorth) / (2 * determinant);
  const radii = samples.map((sample) =>
    Math.hypot(sample.east - centerEast, sample.north - centerNorth),
  );
  const radius = median(radii);
  const residual = median(radii.map((value) => Math.abs(value - radius)));
  return { east: centerEast, north: centerNorth, radius, residual };
}

function robustCircle(samples: readonly Velocity[]): Circle | null {
  const initial = fitCircle(samples);
  if (!initial) return null;
  const deviations = samples.map((sample) =>
    Math.abs(
      Math.hypot(sample.east - initial.east, sample.north - initial.north) -
        initial.radius,
    ),
  );
  const limit = Math.max(1.25, median(deviations) * 3);
  const kept = samples.filter((_, index) => deviations[index] <= limit);
  return fitCircle(kept) ?? initial;
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
  if (speed < MIN_SPEED_MPS || speed > MAX_SPEED_MPS) return null;
  return speed;
}

function modelSensitivity(
  samples: readonly Velocity[],
  circle: Circle,
  course: number,
  speed: number,
): number {
  let maximum = 0;
  for (let index = 0; index < samples.length; index++) {
    const alternate = robustCircle([
      ...samples.slice(0, index),
      ...samples.slice(index + 1),
    ]);
    if (!alternate) return SHORT_MODEL_MAX_SENSITIVITY_MPS;
    const alternateSpeed = projectedSpeed(alternate, course);
    if (!alternateSpeed) return SHORT_MODEL_MAX_SENSITIVITY_MPS;
    maximum = Math.max(
      maximum,
      Math.abs(alternateSpeed - speed),
      Math.abs(alternate.radius - circle.radius),
      Math.hypot(alternate.east - circle.east, alternate.north - circle.north),
    );
  }
  return maximum;
}

export function estimateReturnSpeed(
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
  );
  const span = headingSpan(samples);
  if (span < MIN_HEADING_SPAN) return null;
  const circle = robustCircle(samples);
  if (!circle || circle.residual > 3 || circle.radius < MIN_SPEED_MPS) {
    return null;
  }
  const speed = projectedSpeed(circle, targetCourse);
  if (!speed) return null;
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
    sensitivity: modelSensitivity(samples, circle, targetCourse, speed),
    windowMs,
  };
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
  targetCourse: number,
): boolean {
  const fix = fixes[index];
  return (
    fix.speed >= MIN_SPEED_MPS &&
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
  targetCourse: number,
): TargetCourseSpeedSample | null {
  if (samples.length < TARGET_COURSE_MIN_SAMPLES) return null;
  const duration = samples[samples.length - 1].timestamp - samples[0].timestamp;
  if (duration < TARGET_COURSE_MIN_DURATION_MS) return null;
  const observedAt = samples[samples.length - 1].timestamp;
  const recent = samples.filter(
    (fix) => fix.timestamp >= observedAt - TARGET_COURSE_SPEED_WINDOW_MS,
  );
  const courseError = median(
    recent.map((fix) => relativeBearing(targetCourse, fix.course)),
  );
  return {
    altitude: median(recent.map((fix) => fix.altitude)),
    course: (targetCourse + courseError + 360) % 360,
    metersPerSecond: robustMean(recent.map((fix) => fix.speed)),
    observedAt,
    sampleCount: recent.length,
  };
}

export function estimateTargetCourseSpeed(
  fixes: readonly Fix[],
  targetCourse: number,
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
    const sample = targetCourseEstimate(samples, targetCourse);
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
    const fixIsUsable = targetCourseFixIsUsable(fixes, index, targetCourse);
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

function blend(
  shorter: ReturnSpeedEstimate,
  longer: ReturnSpeedEstimate,
  shortWeight: number,
): ReturnSpeedEstimate {
  const longWeight = 1 - shortWeight;
  const weighted = (shortValue: number, longValue: number) =>
    shortValue * shortWeight + longValue * longWeight;
  return {
    metersPerSecond: weighted(shorter.metersPerSecond, longer.metersPerSecond),
    conservativeMetersPerSecond: weighted(
      shorter.conservativeMetersPerSecond,
      longer.conservativeMetersPerSecond,
    ),
    windEast: weighted(shorter.windEast, longer.windEast),
    windNorth: weighted(shorter.windNorth, longer.windNorth),
    airspeed: weighted(shorter.airspeed, longer.airspeed),
    residual: weighted(shorter.residual, longer.residual),
    headingSpan: weighted(shorter.headingSpan, longer.headingSpan),
    sampleCount: weighted(shorter.sampleCount, longer.sampleCount),
    sensitivity: weighted(shorter.sensitivity, longer.sensitivity),
    windowMs: weighted(shorter.windowMs, longer.windowMs),
  };
}

function averageModel(
  models: readonly ReturnSpeedEstimate[],
): ReturnSpeedEstimate {
  const field = (select: (model: ReturnSpeedEstimate) => number) =>
    models.reduce((sum, model) => sum + select(model), 0) / models.length;
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

function shortModelReliability(model: ReturnSpeedEstimate | null): number {
  if (!model) return 0;
  const headingConfidence = increasingConfidence(
    model.headingSpan,
    MIN_HEADING_SPAN,
    SHORT_MODEL_FULL_HEADING_SPAN,
  );
  const sensitivityConfidence = decliningConfidence(
    model.sensitivity,
    SHORT_MODEL_FULL_SENSITIVITY_MPS,
    SHORT_MODEL_MAX_SENSITIVITY_MPS,
  );
  return Math.min(headingConfidence, sensitivityConfidence);
}

function recentShortModel(
  stable: readonly Fix[],
  targetCourse: number,
): { confidence: number; model: ReturnSpeedEstimate | null } {
  const start = Math.max(
    1,
    stable.length - SHORT_MODEL_CONFIRMATION_FIX_COUNT + 1,
  );
  let confidence = 0;
  let count = 0;
  let model: ReturnSpeedEstimate | null = null;
  for (let end = start; end <= stable.length; end++) {
    const estimate = estimateReturnSpeed(
      stable.slice(0, end),
      targetCourse,
      ADAPTIVE_WINDOWS_MS[0],
    );
    confidence += shortModelReliability(estimate);
    model = estimate ?? model;
    count++;
  }
  return {
    confidence: count > 0 ? confidence / count : 0,
    model,
  };
}

function rawAdaptiveReturnSpeed(
  stable: readonly Fix[],
  targetCourse: number,
  recentShort: { confidence: number; model: ReturnSpeedEstimate | null },
): ReturnSpeedEstimate | null {
  const models = [
    recentShort.model,
    ...ADAPTIVE_WINDOWS_MS.slice(1).map((windowMs) =>
      estimateReturnSpeed(stable, targetCourse, windowMs),
    ),
  ];
  const longModel = models[models.length - 1];
  if (!longModel) return estimateReturnSpeed(stable, targetCourse);
  const shortModels = models.slice(0, 3).map((model) => model ?? longModel);
  const shortModel = averageModel(shortModels);
  return blend(shortModel, longModel, recentShort.confidence);
}

export function estimateAdaptiveReturnSpeed(
  fixes: readonly Fix[],
  targetCourse: number,
): ReturnSpeedEstimate | null {
  const latest = fixes[fixes.length - 1];
  if (!latest) return null;
  const since = latest.timestamp - DEFAULT_WINDOW_MS;
  const stable = stableFixes(fixes.filter((fix) => fix.timestamp >= since));
  return rawAdaptiveReturnSpeed(
    stable,
    targetCourse,
    recentShortModel(stable, targetCourse),
  );
}
