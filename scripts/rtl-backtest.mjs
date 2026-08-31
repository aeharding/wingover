import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

import { etaDisplayMinutes } from "../src/flight/format.ts";
import { shouldShowNavigationArrival } from "../src/ui/shared/navigationDisplay.ts";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const moduleLoader = await createServer({
  appType: "custom",
  cacheDir: "/tmp/wingover-rtl-backtest-vite",
  configFile: false,
  logLevel: "silent",
  root: projectRoot,
  server: { middlewareMode: true },
});
const { deriveNavigationGuidance } = await moduleLoader.ssrLoadModule(
  "/src/flight/navigationGuidance.ts",
);
const {
  estimateAdaptiveReturnSpeed,
  estimateReturnSpeed,
  estimateTargetCourseSpeed,
} = await moduleLoader.ssrLoadModule("/src/flight/returnSpeed.ts");

const ONE_MILE_M = 1609.344;
const ARRIVAL_RADIUS_M = 200;
const EARTH_RADIUS_M = 6371000;
const MIN_PREFIX_MS = 5 * 60 * 1000;
const MIN_PROJECTED_SPEED_MPS = 3;
const MODEL_WINDOW_MS = 30 * 60 * 1000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const TWENTY_MINUTES_MS = 20 * 60 * 1000;
const TARGET_COURSE_EXPERIMENTS = [
  { angle: 10, minutes: 2, minimumSamples: 3 },
  { angle: 10, minutes: 5, minimumSamples: 3 },
  { angle: 15, minutes: 2, minimumSamples: 3 },
  { angle: 15, minutes: 5, minimumSamples: 3 },
  { angle: 20, minutes: 2, minimumSamples: 3 },
  { angle: 20, minutes: 5, minimumSamples: 3 },
];
const POINT_PATTERN = /<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/g;
const DISPLAY_ROUNDED = new Set([
  "current",
  "noDynamic",
  "noFastTurns",
  "noTurns",
  "adaptive",
  "productionDisplay",
  "productionClosing",
  "projected95",
  "projectedClosing",
  "production90",
  "production95",
  "recent15",
  "recent20",
  "stable15",
  "stable15Alt150",
  "stable15Alt300",
  "stable20",
  "stable30Alt150",
  "targetEncounter",
  "targetEncounterHybrid",
  ...TARGET_COURSE_EXPERIMENTS.flatMap((experiment) => [
    targetExperimentName(experiment),
    targetHybridName(experiment),
  ]),
]);

function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[middle];
  return (ordered[middle - 1] + ordered[middle]) / 2;
}

function percentile(values, percent) {
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(ordered.length * percent) - 1);
  return ordered[index];
}

function haversineMeters(a, b) {
  const toRadians = Math.PI / 180;
  const latitude = (b.latitude - a.latitude) * toRadians;
  const longitude = (b.longitude - a.longitude) * toRadians;
  const sinLatitude = Math.sin(latitude / 2);
  const sinLongitude = Math.sin(longitude / 2);
  const h =
    sinLatitude * sinLatitude +
    Math.cos(a.latitude * toRadians) *
      Math.cos(b.latitude * toRadians) *
      sinLongitude *
      sinLongitude;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

function bearingBetween(from, to) {
  const toRadians = Math.PI / 180;
  const latitudeFrom = from.latitude * toRadians;
  const latitudeTo = to.latitude * toRadians;
  const longitude = (to.longitude - from.longitude) * toRadians;
  const y = Math.sin(longitude) * Math.cos(latitudeTo);
  const x =
    Math.cos(latitudeFrom) * Math.sin(latitudeTo) -
    Math.sin(latitudeFrom) * Math.cos(latitudeTo) * Math.cos(longitude);
  return (Math.atan2(y, x) / toRadians + 360) % 360;
}

function relativeBearing(course, bearing) {
  return ((bearing - course + 540) % 360) - 180;
}

function turnRateAt(fixes, index) {
  const previous = fixes[index - 1];
  const current = fixes[index];
  if (!previous || !current) return 0;
  const seconds = (current.timestamp - previous.timestamp) / 1000;
  if (seconds <= 0) return 0;
  return Math.abs(relativeBearing(previous.course, current.course)) / seconds;
}

function calibrationDynamics(fixes) {
  const latest = fixes[fixes.length - 1];
  const since = latest.timestamp - MODEL_WINDOW_MS;
  const indexes = fixes
    .map((fix, index) => ({ fix, index }))
    .filter(
      ({ fix }) => fix.timestamp >= since && fix.speed >= 5 && fix.speed <= 40,
    );
  const turnRates = indexes.map(({ index }) => turnRateAt(fixes, index));
  const climbRates = indexes.map(({ fix }) => Math.abs(fix.climbRate));
  const wingoverSamples = indexes.filter(({ fix, index }) => {
    return turnRateAt(fixes, index) >= 8 && Math.abs(fix.climbRate) >= 2;
  }).length;
  return {
    samples: indexes.length,
    p95TurnRate: percentile(turnRates, 0.95),
    p95ClimbRate: percentile(climbRates, 0.95),
    rapidTurnSamples: turnRates.filter((rate) => rate >= 8).length,
    wingoverSamples,
  };
}

function estimateWithoutManeuvers(
  fixes,
  course,
  maxTurnRate,
  maxClimbRate,
  windowMs = MODEL_WINDOW_MS,
  maxAltitudeDifference = Number.POSITIVE_INFINITY,
) {
  const latest = fixes[fixes.length - 1];
  const marked = fixes.map((fix, index) => {
    const dynamic =
      turnRateAt(fixes, index) > maxTurnRate ||
      Math.abs(fix.climbRate) > maxClimbRate ||
      Math.abs(fix.altitude - latest.altitude) > maxAltitudeDifference;
    if (!dynamic) return fix;
    return { ...fix, horizontalAccuracy: 101 };
  });
  return estimateReturnSpeed(marked, course, windowMs);
}

function targetCourseSpeed(
  fixes,
  targetCourse,
  windowMs,
  maximumError,
  minimumSamples,
) {
  const latest = fixes[fixes.length - 1];
  if (!latest) return null;
  const since = latest.timestamp - windowMs;
  const speeds = fixes
    .map((fix, index) => ({ fix, index }))
    .filter(({ fix, index }) => {
      return (
        fix.timestamp >= since &&
        fix.speed >= 5 &&
        fix.speed <= 40 &&
        fix.horizontalAccuracy <= 100 &&
        turnRateAt(fixes, index) <= 5 &&
        Math.abs(fix.climbRate) <= 3 &&
        Math.abs(relativeBearing(fix.course, targetCourse)) <= maximumError
      );
    })
    .map(({ fix }) => fix.speed);
  if (speeds.length < minimumSamples) return null;
  return median(speeds);
}

function targetExperimentName({ angle, minutes, minimumSamples }) {
  return `target${minutes}m${angle}deg${minimumSamples}s`;
}

function targetHybridName(experiment) {
  return `${targetExperimentName(experiment)}Hybrid`;
}

function productionReturnSpeed(fixes, target) {
  const guidance = deriveNavigationGuidance(fixes, {
    kind: "launch",
    latitude: target.latitude,
    longitude: target.longitude,
  });
  if (!shouldShowNavigationArrival(guidance, "launch")) return null;
  return guidance.distanceMeters / guidance.etaSeconds;
}

function pathDistance(fixes, startIndex, endIndex) {
  let distance = 0;
  for (let index = startIndex + 1; index <= endIndex; index++) {
    distance += haversineMeters(fixes[index - 1], fixes[index]);
  }
  return distance;
}

function windLabel(model) {
  if (!model) return "unconstrained";
  const windSpeedMph = Math.hypot(model.windEast, model.windNorth) * 2.23694;
  const windToward =
    ((Math.atan2(model.windEast, model.windNorth) * 180) / Math.PI + 360) % 360;
  const windFrom = (windToward + 180) % 360;
  const airspeedMph = model.airspeed * 2.23694;
  return `${windSpeedMph.toFixed(1)} mph from ${Math.round(windFrom)}°, air ${airspeedMph.toFixed(1)}, span ${Math.round(model.headingSpan)}°`;
}

function returnLabel(fixes) {
  const launch = fixes[0];
  const latest = fixes[fixes.length - 1];
  const distance = haversineMeters(latest, launch);
  const course = bearingBetween(latest, launch);
  const model = estimateAdaptiveReturnSpeed(fixes, course);
  if (!model) return "RTL unconstrained";
  const speedMph = model.conservativeMetersPerSecond * 2.23694;
  const etaMinutes = distance / model.conservativeMetersPerSecond / 60;
  return `RTL ${(distance / ONE_MILE_M).toFixed(1)} mi, ${etaMinutes.toFixed(1)} min @ ${speedMph.toFixed(1)} mph/${Math.round(model.windowMs / 60_000)}m`;
}

function courseEtaLabel(fixes, course) {
  if (course === null) return null;
  const model = estimateAdaptiveReturnSpeed(fixes, course);
  if (!model) return `10 mi course ${Math.round(course)}° unconstrained`;
  const etaMinutes = (10 * ONE_MILE_M) / model.conservativeMetersPerSecond / 60;
  const speedMph = model.conservativeMetersPerSecond * 2.23694;
  const candidates = [5, 10, 15]
    .map((minutes) =>
      estimateWithoutManeuvers(fixes, course, 5, 3, minutes * 60_000),
    )
    .map((candidate) =>
      candidate
        ? (candidate.conservativeMetersPerSecond * 2.23694).toFixed(1)
        : "x",
    );
  const target = estimateTargetCourseSpeed(fixes, course);
  const targetLabel = target
    ? `, target ${(target.metersPerSecond * 2.23694).toFixed(1)} mph age ${Math.round((fixes[fixes.length - 1].timestamp - target.observedAt) / 1000)}s`
    : "";
  return `10 mi course ${Math.round(course)}° ETA ${etaMinutes.toFixed(1)} min @ ${speedMph.toFixed(1)} mph${targetLabel} [${candidates.join("/")}]`;
}

function traceFlight(fixes, fixedCourse) {
  const startedAt = fixes[0].timestamp;
  let nextAt = startedAt + 5 * 60 * 1000;
  for (let index = 1; index < fixes.length; index++) {
    const latest = fixes[index];
    if (latest.timestamp < nextAt) continue;
    const prefix = fixes.slice(0, index + 1);
    const raw15 = estimateReturnSpeed(
      prefix,
      latest.course,
      FIFTEEN_MINUTES_MS,
    );
    const stable15 = estimateWithoutManeuvers(
      prefix,
      latest.course,
      5,
      3,
      FIFTEEN_MINUTES_MS,
    );
    const stable5 = estimateWithoutManeuvers(
      prefix,
      latest.course,
      5,
      3,
      FIVE_MINUTES_MS,
    );
    const stable10 = estimateWithoutManeuvers(
      prefix,
      latest.course,
      5,
      3,
      TEN_MINUTES_MS,
    );
    const raw30 = estimateReturnSpeed(prefix, latest.course, MODEL_WINDOW_MS);
    const adaptive = estimateAdaptiveReturnSpeed(prefix, latest.course);
    const elapsedMinutes = (latest.timestamp - startedAt) / 60_000;
    const altitudeFeet = latest.altitude * 3.28084;
    const fixedCourseLabel = courseEtaLabel(prefix, fixedCourse);
    console.log(
      `${elapsedMinutes.toFixed(0).padStart(2, "0")}m ${altitudeFeet.toFixed(0).padStart(4, " ")} ft | ${fixedCourseLabel ? `${fixedCourseLabel} | ` : ""}${returnLabel(prefix)} | adaptive ${windLabel(adaptive)} | 5m ${windLabel(stable5)} | 10m ${windLabel(stable10)} | 15m raw ${windLabel(raw15)} | 15m stable ${windLabel(stable15)} | 30m ${windLabel(raw30)}`,
    );
    nextAt += 2 * 60 * 1000;
  }
}

function tag(body, name) {
  return body.match(new RegExp(`<${name}>([^<]+)</${name}>`))?.[1] ?? null;
}

function attribute(body, name) {
  return body.match(new RegExp(`\\b${name}="([^"]+)"`))?.[1] ?? null;
}

function parsePoints(xml) {
  const points = [];
  for (const match of xml.matchAll(POINT_PATTERN)) {
    const latitude = Number(attribute(match[1], "lat") ?? Number.NaN);
    const longitude = Number(attribute(match[1], "lon") ?? Number.NaN);
    const timestamp = Date.parse(tag(match[2], "time") ?? "");
    const altitude = Number(tag(match[2], "ele") ?? 0);
    if (
      Number.isFinite(latitude) &&
      Number.isFinite(longitude) &&
      Number.isFinite(timestamp)
    ) {
      points.push({ latitude, longitude, altitude, timestamp });
    }
  }
  points.sort((a, b) => a.timestamp - b.timestamp);
  const retained = [];
  for (const point of points) {
    const previous = retained[retained.length - 1];
    if (!previous || point.timestamp - previous.timestamp >= 500) {
      retained.push(point);
    }
  }
  return retained;
}

function pointCourse(previous, point, next) {
  if (previous) return bearingBetween(previous, point);
  if (next) return bearingBetween(point, next);
  return 0;
}

function toFixes(points) {
  return points.map((point, index) => {
    const previous = points[index - 1];
    const next = points[index + 1];
    const course = pointCourse(previous, point, next);
    const seconds = previous
      ? (point.timestamp - previous.timestamp) / 1000
      : 0;
    const speed =
      previous && seconds > 0 ? haversineMeters(previous, point) / seconds : 0;
    const climbRate =
      previous && seconds > 0
        ? (point.altitude - previous.altitude) / seconds
        : 0;
    return {
      ...point,
      speed,
      course,
      climbRate,
      horizontalAccuracy: 0,
      verticalAccuracy: 0,
    };
  });
}

function closingAt(fixes, distances, index) {
  const now = fixes[index];
  let previousIndex = index - 1;
  while (
    previousIndex > 0 &&
    now.timestamp - fixes[previousIndex].timestamp < 10_000
  ) {
    previousIndex--;
  }
  const elapsed = (now.timestamp - fixes[previousIndex].timestamp) / 1000;
  if (elapsed < 5) return 0;
  return (distances[previousIndex] - distances[index]) / elapsed;
}

function radiusCrossingTimestamp(fixes, distances, arrivalIndex) {
  const after = fixes[arrivalIndex];
  const before = fixes[arrivalIndex - 1];
  if (!before) return after.timestamp;
  const beforeDistance = distances[arrivalIndex - 1];
  const afterDistance = distances[arrivalIndex];
  const distanceChange = beforeDistance - afterDistance;
  if (distanceChange <= 0) return after.timestamp;
  const progress = Math.min(
    1,
    Math.max(0, (beforeDistance - ARRIVAL_RADIUS_M) / distanceChange),
  );
  return before.timestamp + (after.timestamp - before.timestamp) * progress;
}

function projectedClosingAt(fixes, index, target) {
  const latest = fixes[index];
  const since = latest.timestamp - 5_000;
  const speeds = fixes
    .slice(0, index + 1)
    .filter((fix) => fix.timestamp >= since)
    .map((fix) => {
      const targetCourse = bearingBetween(fix, target);
      const error = relativeBearing(fix.course, targetCourse);
      return fix.speed * Math.cos((error * Math.PI) / 180);
    })
    .filter((speed) => speed >= MIN_PROJECTED_SPEED_MPS);
  return speeds.length > 0 ? median(speeds) : 0;
}

function inboundRun(fixes, distances, entryIndex) {
  const launch = fixes[0];
  const qualified = [];
  let badMilliseconds = 0;
  for (let index = entryIndex - 1; index > 0; index--) {
    const fix = fixes[index];
    const bearing = bearingBetween(fix, launch);
    const error = Math.abs(relativeBearing(fix.course, bearing));
    const good =
      fix.speed >= 1 && error <= 35 && closingAt(fixes, distances, index) >= 1;
    if (good) {
      qualified.push(index);
      badMilliseconds = 0;
    } else {
      badMilliseconds += fixes[index + 1].timestamp - fix.timestamp;
      if (badMilliseconds > 12_000) break;
    }
  }
  if (qualified.length < 3) return null;
  const startIndex = Math.min(...qualified);
  const duration = fixes[entryIndex].timestamp - fixes[startIndex].timestamp;
  if (duration < 30_000) return null;
  return { startIndex, qualified };
}

function settledSample(
  fixes,
  distances,
  startIndex,
  arrivalIndex,
  launch,
  delayMs,
) {
  const settledIndex = fixes.findIndex(
    (fix, index) =>
      index >= startIndex &&
      fix.timestamp >= fixes[startIndex].timestamp + delayMs,
  );
  if (settledIndex <= startIndex || settledIndex >= arrivalIndex) return null;
  const remaining = Math.max(0, distances[settledIndex] - ARRIVAL_RADIUS_M);
  const actualSeconds =
    (radiusCrossingTimestamp(fixes, distances, arrivalIndex) -
      fixes[settledIndex].timestamp) /
    1000;
  const closing = closingAt(fixes, distances, settledIndex);
  const projectedClosing = projectedClosingAt(fixes, settledIndex, launch);
  const course = bearingBetween(fixes[settledIndex], launch);
  const model = estimateReturnSpeed(fixes.slice(0, settledIndex + 1), course);
  const adaptive = estimateAdaptiveReturnSpeed(
    fixes.slice(0, settledIndex + 1),
    course,
  );
  const targetEncounter = estimateTargetCourseSpeed(
    fixes.slice(0, settledIndex + 1),
    launch,
  );
  const modeledSpeed = model?.conservativeMetersPerSecond ?? closing;
  const adaptiveSpeed =
    adaptive?.conservativeMetersPerSecond ?? projectedClosing;
  const productionSpeed = productionReturnSpeed(
    fixes.slice(0, settledIndex + 1),
    launch,
  );
  return {
    actualSeconds,
    remaining,
    speeds: {
      current: fixes[settledIndex].speed,
      closing,
      blended: closing * 0.75 + modeledSpeed * 0.25,
      productionDisplay: productionSpeed,
      productionClosing: closing,
      production90: closing * 0.9 + modeledSpeed * 0.1,
      production95: closing * 0.95 + modeledSpeed * 0.05,
      projected95: projectedClosing * 0.95 + modeledSpeed * 0.05,
      projectedClosing,
      targetEncounter: targetEncounter?.metersPerSecond ?? null,
      targetEncounterHybrid: targetEncounter?.metersPerSecond ?? adaptiveSpeed,
    },
  };
}

function analyzeFlight(fixes, file) {
  if (fixes.length < 300) return null;
  const launch = fixes[0];
  const distances = fixes.map((fix) => haversineMeters(fix, launch));
  if (distances[distances.length - 1] > 500) return null;
  let maximumDistance = 0;
  for (const distance of distances) {
    maximumDistance = Math.max(maximumDistance, distance);
  }
  if (maximumDistance < ONE_MILE_M * 1.5) return null;
  let outsideIndex = -1;
  for (let index = distances.length - 1; index >= 0; index--) {
    if (distances[index] > ONE_MILE_M) {
      outsideIndex = index;
      break;
    }
  }
  if (outsideIndex < 0 || outsideIndex + 1 >= fixes.length) return null;
  const entryIndex = outsideIndex + 1;
  const inbound = inboundRun(fixes, distances, entryIndex);
  if (!inbound) return null;
  const arrivalOffset = distances
    .slice(entryIndex)
    .findIndex((distance) => distance <= ARRIVAL_RADIUS_M);
  if (arrivalOffset < 0) return null;
  const arrivalIndex = entryIndex + arrivalOffset;
  const prefix = fixes.slice(0, inbound.startIndex + 1);
  if (
    prefix.length < 2 ||
    prefix[prefix.length - 1].timestamp - prefix[0].timestamp < MIN_PREFIX_MS
  ) {
    return null;
  }
  const remaining = Math.max(
    0,
    distances[inbound.startIndex] - ARRIVAL_RADIUS_M,
  );
  const actualSeconds =
    (radiusCrossingTimestamp(fixes, distances, arrivalIndex) -
      fixes[inbound.startIndex].timestamp) /
    1000;
  if (remaining < 500 || actualSeconds <= 0) return null;
  const course = bearingBetween(fixes[inbound.startIndex], launch);
  const recent = prefix.filter(
    (fix) =>
      fix.timestamp >= prefix[prefix.length - 1].timestamp - 5 * 60 * 1000,
  );
  const validRecent = recent
    .map((fix) => fix.speed)
    .filter((speed) => speed >= 5 && speed <= 40);
  if (validRecent.length === 0) return null;
  const model = estimateReturnSpeed(prefix, course);
  const adaptive = estimateAdaptiveReturnSpeed(prefix, course);
  const targetEncounter = estimateTargetCourseSpeed(prefix, launch);
  const productionSpeed = productionReturnSpeed(prefix, launch);
  const recent15 = estimateReturnSpeed(prefix, course, FIFTEEN_MINUTES_MS);
  const recent20 = estimateReturnSpeed(prefix, course, TWENTY_MINUTES_MS);
  const noFastTurns = estimateWithoutManeuvers(
    prefix,
    course,
    8,
    Number.POSITIVE_INFINITY,
  );
  const noTurns = estimateWithoutManeuvers(
    prefix,
    course,
    3,
    Number.POSITIVE_INFINITY,
  );
  const noDynamic = estimateWithoutManeuvers(prefix, course, 5, 3);
  const stable15 = estimateWithoutManeuvers(
    prefix,
    course,
    5,
    3,
    FIFTEEN_MINUTES_MS,
  );
  const stable20 = estimateWithoutManeuvers(
    prefix,
    course,
    5,
    3,
    TWENTY_MINUTES_MS,
  );
  const stable15Alt150 = estimateWithoutManeuvers(
    prefix,
    course,
    5,
    3,
    FIFTEEN_MINUTES_MS,
    150,
  );
  const stable15Alt300 = estimateWithoutManeuvers(
    prefix,
    course,
    5,
    3,
    FIFTEEN_MINUTES_MS,
    300,
  );
  const stable30Alt150 = estimateWithoutManeuvers(
    prefix,
    course,
    5,
    3,
    MODEL_WINDOW_MS,
    150,
  );
  const settled = settledSample(
    fixes,
    distances,
    inbound.startIndex,
    arrivalIndex,
    launch,
    12_000,
  );
  const settled3 = settledSample(
    fixes,
    distances,
    inbound.startIndex,
    arrivalIndex,
    launch,
    3000,
  );
  const settled4 = settledSample(
    fixes,
    distances,
    inbound.startIndex,
    arrivalIndex,
    launch,
    4000,
  );
  const settled5 = settledSample(
    fixes,
    distances,
    inbound.startIndex,
    arrivalIndex,
    launch,
    5000,
  );
  const settled30 = settledSample(
    fixes,
    distances,
    inbound.startIndex,
    arrivalIndex,
    launch,
    30_000,
  );
  const settled60 = settledSample(
    fixes,
    distances,
    inbound.startIndex,
    arrivalIndex,
    launch,
    60_000,
  );
  const targetCourseExperiments = Object.fromEntries(
    TARGET_COURSE_EXPERIMENTS.flatMap((experiment) => {
      const speed = targetCourseSpeed(
        prefix,
        course,
        experiment.minutes * 60_000,
        experiment.angle,
        experiment.minimumSamples,
      );
      return [
        [targetExperimentName(experiment), speed],
        [
          targetHybridName(experiment),
          speed ?? adaptive?.conservativeMetersPerSecond ?? null,
        ],
      ];
    }),
  );
  return {
    actualSeconds,
    diagnostics: {
      ...calibrationDynamics(prefix),
      airspeed: model?.airspeed ?? null,
      headingSpan: model?.headingSpan ?? null,
      residual: model?.residual ?? null,
      returnPathEfficiency:
        remaining / pathDistance(fixes, inbound.startIndex, arrivalIndex),
      windSpeed: model ? Math.hypot(model.windEast, model.windNorth) : null,
    },
    experimentalSpeeds: {
      ...targetCourseExperiments,
      adaptive: adaptive?.conservativeMetersPerSecond ?? null,
      noDynamic: noDynamic?.conservativeMetersPerSecond ?? null,
      noFastTurns: noFastTurns?.conservativeMetersPerSecond ?? null,
      noTurns: noTurns?.conservativeMetersPerSecond ?? null,
      recent15: recent15?.conservativeMetersPerSecond ?? null,
      recent20: recent20?.conservativeMetersPerSecond ?? null,
      stable15: stable15?.conservativeMetersPerSecond ?? null,
      stable15Alt150: stable15Alt150?.conservativeMetersPerSecond ?? null,
      stable15Alt300: stable15Alt300?.conservativeMetersPerSecond ?? null,
      stable20: stable20?.conservativeMetersPerSecond ?? null,
      stable30Alt150: stable30Alt150?.conservativeMetersPerSecond ?? null,
      targetEncounter: targetEncounter?.metersPerSecond ?? null,
      targetEncounterHybrid:
        targetEncounter?.metersPerSecond ??
        adaptive?.conservativeMetersPerSecond ??
        null,
    },
    file: path.basename(file),
    startedAt: fixes[0].timestamp,
    remaining,
    settled,
    settledByDelay: {
      3: settled3,
      4: settled4,
      5: settled5,
      12: settled,
      30: settled30,
      60: settled60,
    },
    speeds: {
      current: Math.max(5, prefix[prefix.length - 1].speed),
      recentMedian: median(validRecent),
      circle: model?.metersPerSecond ?? null,
      circleConservative: model?.conservativeMetersPerSecond ?? null,
      productionDisplay: productionSpeed,
    },
  };
}

function addResult(results, name, speed, sample) {
  if (!speed) return;
  results.get(name).push(errorMinutes(name, speed, sample));
}

function errorMinutes(name, speed, sample) {
  const rawSeconds = sample.remaining / speed;
  const predictedSeconds = DISPLAY_ROUNDED.has(name)
    ? etaDisplayMinutes(rawSeconds) * 60
    : rawSeconds;
  return (predictedSeconds - sample.actualSeconds) / 60;
}

function summarize(errors, eligible) {
  if (errors.length === 0) {
    return {
      flights: 0,
      coverage: "0%",
      medianAbsoluteMinutes: "n/a",
      p90AbsoluteMinutes: "n/a",
      p95AbsoluteMinutes: "n/a",
      meanBiasMinutes: "n/a",
      p10Minutes: "n/a",
      optimisticOver2Minutes: "0/0",
    };
  }
  const absolute = errors.map(Math.abs);
  const mean = errors.reduce((sum, value) => sum + value, 0) / errors.length;
  const optimisticCount = errors.filter((value) => value < -2).length;
  const optimistic = optimisticCount / errors.length;
  return {
    flights: errors.length,
    coverage: `${Math.round((errors.length / eligible) * 100)}%`,
    medianAbsoluteMinutes: median(absolute).toFixed(2),
    p90AbsoluteMinutes: percentile(absolute, 0.9).toFixed(2),
    p95AbsoluteMinutes: percentile(absolute, 0.95).toFixed(2),
    meanBiasMinutes: mean.toFixed(2),
    p10Minutes: percentile(errors, 0.1).toFixed(2),
    optimisticOver2Minutes: `${optimisticCount}/${errors.length} (${Math.round(optimistic * 100)}%)`,
  };
}

function diagnosticSummary(samples) {
  const withEstimate = samples.filter(
    (sample) => sample.speeds.productionDisplay !== null,
  );
  const errors = withEstimate.map((sample) =>
    errorMinutes("productionDisplay", sample.speeds.productionDisplay, sample),
  );
  if (errors.length === 0) return { flights: 0 };
  return summarize(errors, samples.length);
}

function experimentalSummary(samples, name) {
  const withEstimate = samples.filter(
    (sample) => sample.experimentalSpeeds[name],
  );
  const errors = withEstimate.map((sample) =>
    errorMinutes(name, sample.experimentalSpeeds[name], sample),
  );
  if (errors.length === 0) return { flights: 0 };
  return summarize(errors, samples.length);
}

function settledSummary(samples, name, delaySeconds) {
  const withEstimate = samples.filter(
    (sample) => sample.settledByDelay[delaySeconds]?.speeds[name],
  );
  const errors = withEstimate.map((sample) =>
    errorMinutes(
      name,
      sample.settledByDelay[delaySeconds].speeds[name],
      sample.settledByDelay[delaySeconds],
    ),
  );
  if (errors.length === 0) return { flights: 0 };
  return summarize(errors, samples.length);
}

function printDynamicsDiagnostics(samples) {
  const wingoverCounts = samples.map(
    (sample) => sample.diagnostics.wingoverSamples,
  );
  const rapidTurnCounts = samples.map(
    (sample) => sample.diagnostics.rapidTurnSamples,
  );
  const lowWingover = percentile(wingoverCounts, 0.25);
  const highWingover = percentile(wingoverCounts, 0.75);
  const lowRapidTurns = percentile(rapidTurnCounts, 0.25);
  const highRapidTurns = percentile(rapidTurnCounts, 0.75);
  const directReturns = samples.filter(
    (sample) => sample.diagnostics.returnPathEfficiency >= 0.9,
  );
  const indirectReturns = samples.filter(
    (sample) => sample.diagnostics.returnPathEfficiency < 0.75,
  );
  console.log("Production display by calibration-window dynamics");
  console.log(
    `low wingover proxy (<=${lowWingover} samples)`,
    diagnosticSummary(
      samples.filter(
        (sample) => sample.diagnostics.wingoverSamples <= lowWingover,
      ),
    ),
  );
  console.log(
    `high wingover proxy (>=${highWingover} samples)`,
    diagnosticSummary(
      samples.filter(
        (sample) => sample.diagnostics.wingoverSamples >= highWingover,
      ),
    ),
  );
  console.log(
    `few rapid turns (<=${lowRapidTurns} samples)`,
    diagnosticSummary(
      samples.filter(
        (sample) => sample.diagnostics.rapidTurnSamples <= lowRapidTurns,
      ),
    ),
  );
  console.log(
    `many rapid turns (>=${highRapidTurns} samples)`,
    diagnosticSummary(
      samples.filter(
        (sample) => sample.diagnostics.rapidTurnSamples >= highRapidTurns,
      ),
    ),
  );
  console.log(
    "direct returns (>=90% efficient)",
    diagnosticSummary(directReturns),
  );
  console.log(
    "indirect returns (<75% efficient)",
    diagnosticSummary(indirectReturns),
  );
  console.log("Experiments on direct returns");
  for (const name of [
    "targetEncounter",
    "targetEncounterHybrid",
    "adaptive",
    "noDynamic",
    "noFastTurns",
    "recent15",
    "recent20",
    "stable15",
    "stable15Alt150",
    "stable15Alt300",
    "stable20",
    "stable30Alt150",
  ]) {
    console.log(name, experimentalSummary(directReturns, name));
  }
  for (const delaySeconds of [3, 4, 5, 12, 30, 60]) {
    console.log(`Stable-inbound weights after ${delaySeconds} s`);
    for (const name of [
      "targetEncounter",
      "targetEncounterHybrid",
      "productionDisplay",
      "production90",
      "production95",
      "productionClosing",
      "projected95",
      "projectedClosing",
    ]) {
      console.log(name, settledSummary(directReturns, name, delaySeconds));
    }
  }

  const worst = samples
    .map((sample) => ({
      error: errorMinutes(
        "productionDisplay",
        sample.speeds.productionDisplay,
        sample,
      ),
      sample,
    }))
    .sort((a, b) => a.error - b.error)
    .slice(0, 10)
    .map(({ error, sample }) => ({
      file: sample.file,
      errorMinutes: error.toFixed(2),
      actualMinutes: (sample.actualSeconds / 60).toFixed(2),
      distanceMiles: (sample.remaining / ONE_MILE_M).toFixed(2),
      p95TurnRate: sample.diagnostics.p95TurnRate.toFixed(1),
      p95ClimbRate: sample.diagnostics.p95ClimbRate.toFixed(1),
      rapidTurnSamples: sample.diagnostics.rapidTurnSamples,
      wingoverSamples: sample.diagnostics.wingoverSamples,
      residual: sample.diagnostics.residual?.toFixed(2),
      returnPathEfficiency: sample.diagnostics.returnPathEfficiency.toFixed(2),
      airspeed: sample.diagnostics.airspeed?.toFixed(1),
      windSpeed: sample.diagnostics.windSpeed?.toFixed(1),
      noDynamicError: sample.experimentalSpeeds.noDynamic
        ? errorMinutes(
            "noDynamic",
            sample.experimentalSpeeds.noDynamic,
            sample,
          ).toFixed(2)
        : null,
      noFastTurnsError: sample.experimentalSpeeds.noFastTurns
        ? errorMinutes(
            "noFastTurns",
            sample.experimentalSpeeds.noFastTurns,
            sample,
          ).toFixed(2)
        : null,
    }));
  console.log("Ten most optimistic production estimates", worst);
}

function printAdaptiveComparisons(samples) {
  const comparisons = samples
    .filter(
      (sample) =>
        sample.experimentalSpeeds.adaptive &&
        sample.experimentalSpeeds.noDynamic,
    )
    .map((sample) => {
      const adaptive = errorMinutes(
        "adaptive",
        sample.experimentalSpeeds.adaptive,
        sample,
      );
      const stableLong = errorMinutes(
        "noDynamic",
        sample.experimentalSpeeds.noDynamic,
        sample,
      );
      return {
        adaptive,
        absoluteChange: Math.abs(adaptive) - Math.abs(stableLong),
        file: sample.file,
        pathEfficiency: sample.diagnostics.returnPathEfficiency,
        stableLong,
      };
    });
  const display = ({
    adaptive,
    absoluteChange,
    file,
    pathEfficiency,
    stableLong,
  }) => ({
    file,
    absoluteChange: absoluteChange.toFixed(2),
    adaptiveError: adaptive.toFixed(2),
    stableLongError: stableLong.toFixed(2),
    pathEfficiency: pathEfficiency.toFixed(2),
  });
  console.log(
    "Largest adaptive regressions",
    [...comparisons]
      .sort((a, b) => b.absoluteChange - a.absoluteChange)
      .slice(0, 10)
      .map(display),
  );
  console.log(
    "Largest adaptive improvements",
    [...comparisons]
      .sort((a, b) => a.absoluteChange - b.absoluteChange)
      .slice(0, 10)
      .map(display),
  );
}

async function gpxFiles(input) {
  const info = await stat(input);
  if (!info.isDirectory()) return [input];
  const names = await readdir(input);
  return names
    .filter((name) => name.toLowerCase().endsWith(".gpx"))
    .map((name) => path.join(input, name));
}

function flightSignature(fixes) {
  const first = fixes[0];
  const latest = fixes[fixes.length - 1];
  if (!first || !latest) return "empty";
  return [
    first.timestamp,
    latest.timestamp,
    fixes.length,
    first.latitude.toFixed(6),
    first.longitude.toFixed(6),
    latest.latitude.toFixed(6),
    latest.longitude.toFixed(6),
  ].join(":");
}

function corpusEligibility(fixes) {
  if (fixes.length < 300) return "short";
  const launch = fixes[0];
  const distances = fixes.map((fix) => haversineMeters(fix, launch));
  let maximumDistance = 0;
  for (const distance of distances) {
    maximumDistance = Math.max(maximumDistance, distance);
  }
  if (maximumDistance < ONE_MILE_M * 1.5) return "near";
  return distances[distances.length - 1] <= 500
    ? "ended-near-launch"
    : "ended-away";
}

async function main() {
  const input = process.argv[2];
  if (!input) {
    throw new Error("Usage: pnpm backtest:rtl /absolute/path/to/gpx-directory");
  }
  const files = await gpxFiles(input);
  if (process.argv.includes("--trace")) {
    if (files.length !== 1) {
      throw new Error("--trace requires one GPX file");
    }
    const courseArgument = process.argv.find((argument) =>
      argument.startsWith("--course="),
    );
    const fixedCourse = courseArgument
      ? Number(courseArgument.slice("--course=".length))
      : null;
    if (fixedCourse !== null && !Number.isFinite(fixedCourse)) {
      throw new Error("--course must be a number of degrees");
    }
    traceFlight(
      toFixes(parsePoints(await readFile(files[0], "utf8"))),
      fixedCourse,
    );
    return;
  }
  const results = new Map([
    ["current", []],
    ["recentMedian", []],
    ["circle", []],
    ["circleConservative", []],
    ["productionDisplay", []],
  ]);
  const settledResults = new Map([
    ["current", []],
    ["closing", []],
    ["blended", []],
    ["productionDisplay", []],
    ["production90", []],
    ["production95", []],
    ["productionClosing", []],
    ["projected95", []],
    ["projectedClosing", []],
    ["targetEncounter", []],
    ["targetEncounterHybrid", []],
  ]);
  const experimentalResults = new Map([
    ...TARGET_COURSE_EXPERIMENTS.flatMap((experiment) => [
      [targetExperimentName(experiment), []],
      [targetHybridName(experiment), []],
    ]),
    ["adaptive", []],
    ["noDynamic", []],
    ["noFastTurns", []],
    ["noTurns", []],
    ["recent15", []],
    ["recent20", []],
    ["stable15", []],
    ["stable15Alt150", []],
    ["stable15Alt300", []],
    ["stable20", []],
    ["stable30Alt150", []],
    ["targetEncounter", []],
    ["targetEncounterHybrid", []],
  ]);
  const samples = [];
  const signatures = new Set();
  const eligibility = new Map([
    ["short", 0],
    ["near", 0],
    ["ended-near-launch", 0],
    ["ended-away", 0],
    ["duplicate", 0],
    ["ended-near-without-qualifying-rtl", 0],
  ]);
  for (const file of files) {
    const fixes = toFixes(parsePoints(await readFile(file, "utf8")));
    const signature = flightSignature(fixes);
    if (signatures.has(signature)) {
      eligibility.set("duplicate", eligibility.get("duplicate") + 1);
      continue;
    }
    signatures.add(signature);
    const category = corpusEligibility(fixes);
    eligibility.set(category, eligibility.get(category) + 1);
    const sample = analyzeFlight(fixes, file);
    if (!sample) {
      if (category === "ended-near-launch") {
        eligibility.set(
          "ended-near-without-qualifying-rtl",
          eligibility.get("ended-near-without-qualifying-rtl") + 1,
        );
      }
      continue;
    }
    samples.push(sample);
  }
  if (samples.length === 0) {
    console.log("No qualifying successful RTL samples", {
      files: files.length,
      ...Object.fromEntries(eligibility),
    });
    return;
  }
  samples.sort((a, b) => a.startedAt - b.startedAt);
  const evaluationStart = Math.floor(samples.length * 0.7);
  const evaluation = samples.slice(evaluationStart);
  for (const sample of samples) {
    for (const [name, speed] of Object.entries(sample.speeds)) {
      addResult(results, name, speed, sample);
    }
    for (const [name, speed] of Object.entries(sample.experimentalSpeeds)) {
      addResult(experimentalResults, name, speed, sample);
    }
    if (sample.settled) {
      for (const [name, speed] of Object.entries(sample.settled.speeds)) {
        addResult(settledResults, name, speed, sample.settled);
      }
    }
  }
  console.log("Corpus eligibility", Object.fromEntries(eligibility));
  if (process.argv.includes("--brief")) {
    const brief = (selected, name, speed) => {
      const errors = selected
        .filter((sample) => speed(sample))
        .map((sample) => errorMinutes(name, speed(sample), sample));
      return summarize(errors, selected.length);
    };
    const directEvaluation = evaluation.filter(
      (sample) => sample.diagnostics.returnPathEfficiency >= 0.9,
    );
    console.log(
      "All adaptive",
      brief(
        samples,
        "adaptive",
        (sample) => sample.experimentalSpeeds.adaptive,
      ),
    );
    console.log(
      "All production",
      brief(
        samples,
        "productionDisplay",
        (sample) => sample.speeds.productionDisplay,
      ),
    );
    console.log(
      "All instantaneous groundspeed",
      brief(samples, "current", (sample) => sample.speeds.current),
    );
    console.log(
      "Chronological evaluation adaptive",
      brief(
        evaluation,
        "adaptive",
        (sample) => sample.experimentalSpeeds.adaptive,
      ),
    );
    console.log(
      "Chronological evaluation production",
      brief(
        evaluation,
        "productionDisplay",
        (sample) => sample.speeds.productionDisplay,
      ),
    );
    console.log(
      "Chronological evaluation instantaneous groundspeed",
      brief(evaluation, "current", (sample) => sample.speeds.current),
    );
    console.log(
      "Direct chronological evaluation adaptive",
      brief(
        directEvaluation,
        "adaptive",
        (sample) => sample.experimentalSpeeds.adaptive,
      ),
    );
    console.log(
      "Direct chronological evaluation production",
      brief(
        directEvaluation,
        "productionDisplay",
        (sample) => sample.speeds.productionDisplay,
      ),
    );
    for (const delay of [3, 4, 5, 12, 30, 60]) {
      const selected = directEvaluation
        .map((sample) => sample.settledByDelay[delay])
        .filter(Boolean);
      console.log(
        `Direct chronological evaluation production after ${delay}s`,
        brief(
          selected,
          "productionDisplay",
          (sample) => sample.speeds.productionDisplay,
        ),
      );
    }
    return;
  }
  console.log(
    `Parsed ${files.length} local GPX files into position-derived fixes; ${samples.length} reached the 200 m launch area from a usable inbound leg.`,
  );
  console.log("All eligible flights");
  for (const [name, errors] of results) {
    console.log(name, summarize(errors, samples.length));
  }
  console.log("Twelve seconds after the stable inbound leg begins");
  const settledEligible = samples.filter((sample) => sample.settled).length;
  for (const [name, errors] of settledResults) {
    console.log(name, summarize(errors, settledEligible));
  }
  console.log("Newest 30% chronological evaluation slice");
  for (const name of results.keys()) {
    const errors = [];
    for (const sample of evaluation) {
      addResult(new Map([[name, errors]]), name, sample.speeds[name], sample);
    }
    console.log(name, summarize(errors, evaluation.length));
  }
  console.log(
    "Newest 30% chronological evaluation, twelve seconds after inbound begins",
  );
  const settledEvaluation = evaluation.filter((sample) => sample.settled);
  for (const name of settledResults.keys()) {
    const errors = [];
    for (const sample of settledEvaluation) {
      addResult(
        new Map([[name, errors]]),
        name,
        sample.settled.speeds[name],
        sample.settled,
      );
    }
    console.log(name, summarize(errors, settledEvaluation.length));
  }
  console.log("Maneuver-filter experiments, all eligible flights");
  for (const [name, errors] of experimentalResults) {
    console.log(name, summarize(errors, samples.length));
  }
  console.log(
    "Maneuver-filter experiments, newest 30% chronological evaluation",
  );
  for (const name of experimentalResults.keys()) {
    const errors = [];
    for (const sample of evaluation) {
      addResult(
        new Map([[name, errors]]),
        name,
        sample.experimentalSpeeds[name],
        sample,
      );
    }
    console.log(name, summarize(errors, evaluation.length));
  }
  printDynamicsDiagnostics(evaluation);
  printAdaptiveComparisons(evaluation);
}

try {
  await main();
} finally {
  await moduleLoader.close();
}
