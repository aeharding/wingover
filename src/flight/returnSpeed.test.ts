import { describe, expect, it } from "vitest";

import type { Fix } from "../engine/types";
import {
  estimateAdaptiveReturnSpeed,
  estimateReturnSpeed,
  estimateTargetCourseSpeed,
} from "./returnSpeed";

function fix(course: number, speed: number, index: number): Fix {
  return {
    timestamp: index * 1000,
    latitude: 43,
    longitude: -89,
    altitude: 300,
    speed,
    course,
    climbRate: 0,
    horizontalAccuracy: 3,
    verticalAccuracy: 5,
  };
}

function windFlight(windEast: number, windNorth: number, airspeed: number) {
  const fixes: Fix[] = [];
  for (let course = 0; course < 360; course += 15) {
    const radians = (course * Math.PI) / 180;
    const airEast = airspeed * Math.sin(radians);
    const airNorth = airspeed * Math.cos(radians);
    const groundEast = airEast + windEast;
    const groundNorth = airNorth + windNorth;
    const groundCourse =
      ((Math.atan2(groundEast, groundNorth) * 180) / Math.PI + 360) % 360;
    const groundSpeed = Math.hypot(groundEast, groundNorth);
    fixes.push(fix(groundCourse, groundSpeed, fixes.length));
  }
  return fixes;
}

function windTimeline(
  phases: readonly {
    minutes: number;
    windEast: number;
    windNorth: number;
    airspeed?: number;
  }[],
  airspeed = 12,
): Fix[] {
  const fixes: Fix[] = [];
  for (const phase of phases) {
    const samples = phase.minutes * 4;
    for (let index = 0; index < samples; index++) {
      const airCourse = (fixes.length * 15) % 360;
      const radians = (airCourse * Math.PI) / 180;
      const phaseAirspeed = phase.airspeed ?? airspeed;
      const east = phaseAirspeed * Math.sin(radians) + phase.windEast;
      const north = phaseAirspeed * Math.cos(radians) + phase.windNorth;
      const groundCourse =
        ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
      fixes.push({
        ...fix(groundCourse, Math.hypot(east, north), fixes.length),
        timestamp: fixes.length * 15_000,
      });
    }
  }
  return fixes;
}

function throttleOscillationAfterStableWind(): Fix[] {
  const fixes = windTimeline([{ minutes: 20, windEast: 1, windNorth: 0 }]);
  const startedAt = fixes[fixes.length - 1].timestamp;
  for (let index = 0; index < 10 * 60; index++) {
    const airCourse = (Math.floor(index / 20) * 15) % 360;
    const radians = (airCourse * Math.PI) / 180;
    const airspeed = index % 2 === 0 ? 8 : 18;
    const east = airspeed * Math.sin(radians) + 1;
    const north = airspeed * Math.cos(radians);
    const groundCourse =
      ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
    fixes.push({
      ...fix(groundCourse, Math.hypot(east, north), fixes.length),
      timestamp: startedAt + (index + 1) * 1000,
      climbRate: Math.floor(index / 2) % 2 === 0 ? 2.5 : -2.5,
    });
  }
  return fixes;
}

function windFix(
  airCourse: number,
  airspeed: number,
  windNorth: number,
  index: number,
  altitude = 300,
): Fix {
  const radians = (airCourse * Math.PI) / 180;
  const east = airspeed * Math.sin(radians);
  const north = airspeed * Math.cos(radians) + windNorth;
  const course = ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
  return {
    ...fix(course, Math.hypot(east, north), index),
    altitude,
  };
}

function sweepingWindChange(): Fix[] {
  return Array.from({ length: 2400 }, (_, index) => {
    const phase = index % 360;
    const airCourse = phase <= 180 ? 90 + phase : 270 - (phase - 180);
    const windNorth = index < 1200 ? 0 : -5;
    return windFix(airCourse, 12, windNorth, index);
  });
}

describe("estimateReturnSpeed", () => {
  it("recovers airspeed and wind from a spread of ground velocities", () => {
    const estimate = estimateReturnSpeed(windFlight(3, -2, 12), 90);
    expect(estimate).not.toBeNull();
    expect(estimate!.windEast).toBeCloseTo(3, 1);
    expect(estimate!.windNorth).toBeCloseTo(-2, 1);
    expect(estimate!.airspeed).toBeCloseTo(12, 1);
    expect(estimate!.metersPerSecond).toBeCloseTo(14.83, 1);
  });

  it("withholds a prediction when headings do not constrain the wind", () => {
    const fixes = Array.from({ length: 30 }, (_, index) =>
      fix(20 + (index % 3), 12, index),
    );
    expect(estimateReturnSpeed(fixes, 180)).toBeNull();
  });

  it("returns a slower uncertainty-adjusted estimate", () => {
    const fixes = windFlight(2, 1, 12).map((sample, index) => ({
      ...sample,
      speed: sample.speed + (index % 2 === 0 ? 0.8 : -0.8),
    }));
    const estimate = estimateReturnSpeed(fixes, 270);
    expect(estimate).not.toBeNull();
    expect(estimate!.conservativeMetersPerSecond).toBeLessThan(
      estimate!.metersPerSecond,
    );
  });

  it("keeps its full uncertainty allowance in a strong headwind", () => {
    const estimate = estimateReturnSpeed(windFlight(0, -6.9, 12), 0)!;

    expect(estimate.metersPerSecond).toBeCloseTo(5.1, 1);
    expect(estimate.conservativeMetersPerSecond).toBeCloseTo(4.35, 1);
  });

  it("pivots when agreeing short windows observe a wind change", () => {
    const fixes = windTimeline([
      { minutes: 20, windEast: 1, windNorth: 0 },
      { minutes: 10, windEast: -5, windNorth: 0 },
    ]);
    const estimate = estimateAdaptiveReturnSpeed(fixes, 90)!;
    expect(estimate.windEast).toBeLessThan(-4);
    expect(estimate.windNorth).toBeCloseTo(0, 0);
  });

  it("does not chase a short model that disagrees with longer windows", () => {
    const fixes = windTimeline([
      { minutes: 27, windEast: 1, windNorth: 0 },
      { minutes: 3, windEast: -8, windNorth: 0 },
    ]);
    const estimate = estimateAdaptiveReturnSpeed(fixes, 90)!;
    expect(estimate.windEast).toBeGreaterThan(-4);
  });

  it("adapts to a sustained stable airspeed change", () => {
    const fixes = windTimeline([
      { minutes: 20, windEast: 1, windNorth: 0, airspeed: 12 },
      { minutes: 10, windEast: 1, windNorth: 0, airspeed: 24 },
    ]);

    const estimate = estimateAdaptiveReturnSpeed(fixes, 90)!;

    expect(estimate.windowMs).toBeLessThanOrEqual(15 * 60_000);
    expect(estimate.airspeed).toBeGreaterThan(20);
  });

  it("does not fit same-course throttle oscillations as changing wind", () => {
    const estimate = estimateAdaptiveReturnSpeed(
      throttleOscillationAfterStableWind(),
      90,
    )!;

    expect(estimate.windowMs).toBe(30 * 60_000);
    expect(estimate.airspeed).toBeCloseTo(12, 0);
  });

  it("hands changing wind models over without threshold chatter", () => {
    const fixes = sweepingWindChange();
    const speeds: number[] = [];
    for (let second = 350; second <= 520; second++) {
      const prefix = fixes.slice(0, 1200 + second + 1);
      speeds.push(
        estimateAdaptiveReturnSpeed(prefix, 0)!.conservativeMetersPerSecond,
      );
    }
    const changes = speeds
      .slice(1)
      .map((speed, index) => Math.abs(speed - speeds[index]));
    const maximumChange = Math.max(...changes);
    const changeIndex = changes.indexOf(maximumChange);

    expect(
      maximumChange,
      JSON.stringify({
        after: speeds[changeIndex + 1],
        before: speeds[changeIndex],
        second: changeIndex + 351,
      }),
    ).toBeLessThan(0.5);
    expect(speeds[speeds.length - 1]).toBeLessThan(8);
    expect(speeds[speeds.length - 1]).toBeLessThan(speeds[0]);
  });

  it("withholds a stale model after moving to a different flight level", () => {
    const lowLevel = Array.from({ length: 80 }, (_, index) =>
      windFix((index * 15) % 360, 12, 4, index, 300),
    ).map((sample, index) => ({ ...sample, timestamp: index * 15_000 }));
    const highLevel = Array.from({ length: 40 }, (_, index) => ({
      ...windFix(90, 12, -4, index + 80, 900),
      climbRate: index === 0 ? 40 : 0,
      timestamp: (index + 80) * 15_000,
    }));

    expect(
      estimateAdaptiveReturnSpeed([...lowLevel, ...highLevel], 0),
    ).toBeNull();
  });
});

describe("estimateTargetCourseSpeed", () => {
  it("uses three stable samples near the target course", () => {
    const fixes = [fix(90, 8, 0), fix(90, 7, 1), fix(90, 6, 2)];

    const estimate = estimateTargetCourseSpeed(fixes, 90);

    expect(estimate?.metersPerSecond).toBe(7);
    expect(estimate?.observedAt).toBe(2000);
    expect(estimate?.sampleCount).toBe(3);
    expect(estimate?.previous).toBeNull();
    expect(estimate?.transitionProgress).toBeCloseTo(1 / 3);
  });

  it("rejects an isolated groundspeed spike", () => {
    const fixes = [
      fix(90, 8, 0),
      fix(90, 8, 1),
      fix(90, 8, 2),
      fix(90, 8, 3),
      fix(90, 30, 4),
    ];

    expect(estimateTargetCourseSpeed(fixes, 90)?.metersPerSecond).toBe(8);
  });

  it("does not qualify while the pilot is still turning", () => {
    const fixes = [fix(0, 12, 0), fix(40, 12, 1), fix(80, 12, 2)];

    expect(estimateTargetCourseSpeed(fixes, 90)).toBeNull();
  });

  it("keeps a stable sample through same-course throttle oscillations", () => {
    const stable = Array.from({ length: 7 }, (_, index) => fix(90, 12, index));
    const separator = fix(0, 12, 7);
    const oscillating = [18, 8, 18, 8].map((speed, index) => ({
      ...fix(90, speed, index + 8),
      climbRate: index % 2 === 0 ? 2.5 : -2.5,
    }));

    const estimate = estimateTargetCourseSpeed(
      [...stable, separator, ...oscillating],
      90,
    );

    expect(estimate?.metersPerSecond).toBe(12);
    expect(estimate?.observedAt).toBe(6000);
  });

  it("uses only the latest five seconds of a sustained change", () => {
    const fixes = Array.from({ length: 20 }, (_, index) =>
      fix(90, index < 12 ? 12 : 7, index),
    );

    expect(estimateTargetCourseSpeed(fixes, 90)?.metersPerSecond).toBe(7);
  });

  it("keeps the prior encounter while fresh evidence gains confidence", () => {
    const prior = Array.from({ length: 7 }, (_, index) => fix(90, 12, index));
    const separator = fix(0, 12, 7);
    const current = Array.from({ length: 4 }, (_, index) =>
      fix(90, 7, index + 8),
    );

    const estimate = estimateTargetCourseSpeed(
      [...prior, separator, ...current],
      90,
    );

    expect(estimate?.metersPerSecond).toBe(7);
    expect(estimate?.previous?.metersPerSecond).toBe(12);
    expect(estimate?.transitionProgress).toBeCloseTo(1 / 3);
  });
});
