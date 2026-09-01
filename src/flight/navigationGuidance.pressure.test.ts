import { describe, expect, it } from "vitest";

import type { Fix } from "../engine/types";
import { bearingBetween } from "./nav";
import {
  deriveNavigationGuidance,
  type NavigationTarget,
} from "./navigationGuidance";
import {
  estimateAdaptiveReturnSpeed,
  estimateReturnSpeed,
} from "./returnSpeed";

const METERS_PER_LATITUDE_DEGREE = 111_320;
const launch: NavigationTarget = {
  kind: "launch",
  latitude: 43,
  longitude: -89,
};

interface GroundVelocity {
  course: number;
  east: number;
  north: number;
  speed: number;
}

interface Scenario {
  fixes: Fix[];
  latitude: number;
  longitude: number;
  timestamp: number;
}

function velocityFromAir(
  airCourse: number,
  airspeed: number,
  windEast: number,
  windNorth: number,
): GroundVelocity {
  const radians = (airCourse * Math.PI) / 180;
  const east = airspeed * Math.sin(radians) + windEast;
  const north = airspeed * Math.cos(radians) + windNorth;
  return {
    course: ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360,
    east,
    north,
    speed: Math.hypot(east, north),
  };
}

function velocityFromCourse(course: number, speed: number): GroundVelocity {
  const radians = (course * Math.PI) / 180;
  return {
    course,
    east: speed * Math.sin(radians),
    north: speed * Math.cos(radians),
    speed,
  };
}

function append(scenario: Scenario, velocity: GroundVelocity, seconds: number) {
  scenario.latitude += (velocity.north * seconds) / METERS_PER_LATITUDE_DEGREE;
  const metersPerLongitudeDegree =
    METERS_PER_LATITUDE_DEGREE * Math.cos((scenario.latitude * Math.PI) / 180);
  scenario.longitude += (velocity.east * seconds) / metersPerLongitudeDegree;
  scenario.timestamp += seconds * 1000;
  scenario.fixes.push({
    timestamp: scenario.timestamp,
    latitude: scenario.latitude,
    longitude: scenario.longitude,
    altitude: 300,
    speed: velocity.speed,
    course: velocity.course,
    climbRate: 0,
    horizontalAccuracy: 3,
    verticalAccuracy: 5,
  });
}

function scenarioWithHeadingCoverage(): Scenario {
  const scenario: Scenario = {
    fixes: [],
    latitude: 43.08,
    longitude: -89,
    timestamp: 0,
  };
  for (let sample = 0; sample < 80; sample++) {
    append(scenario, velocityFromAir((sample * 15) % 360, 12, 0, 0), 15);
  }
  return scenario;
}

function returnSpeed(scenario: Scenario): number {
  const guidance = deriveNavigationGuidance(scenario.fixes, launch);
  if (!guidance?.etaSeconds) return 0;
  return guidance.distanceMeters / guidance.etaSeconds;
}

function appendDirect(scenario: Scenario, speed: number, samples: number) {
  for (let sample = 0; sample < samples; sample++) {
    const point = {
      latitude: scenario.latitude,
      longitude: scenario.longitude,
    };
    append(
      scenario,
      velocityFromCourse(bearingBetween(point, launch), speed),
      1,
    );
  }
}

describe("return ETA pressure", () => {
  it("ramps fresh target-course speed in without a qualification cliff", () => {
    const scenario = scenarioWithHeadingCoverage();
    const speeds: number[] = [];

    for (let second = 0; second < 9; second++) {
      appendDirect(scenario, 7, 1);
      speeds.push(returnSpeed(scenario));
    }

    const changes = speeds
      .slice(1)
      .map((speed, index) => Math.abs(speed - speeds[index]));
    expect(speeds[3]).toBeLessThan(speeds[2]);
    expect(Math.max(...changes)).toBeLessThan(1.5);
    expect(speeds[speeds.length - 1]).toBeCloseTo(7, 5);
  });

  it("reacts to a sustained headwind within five seconds without chasing a spike", () => {
    const scenario = scenarioWithHeadingCoverage();
    appendDirect(scenario, 12, 13);
    expect(returnSpeed(scenario)).toBeCloseTo(12, 5);

    appendDirect(scenario, 30, 1);
    expect(returnSpeed(scenario)).toBeCloseTo(12, 5);
    appendDirect(scenario, 12, 5);
    expect(returnSpeed(scenario)).toBeCloseTo(12, 5);

    const changedSpeeds: number[] = [];
    for (let second = 0; second < 6; second++) {
      appendDirect(scenario, 7, 1);
      changedSpeeds.push(returnSpeed(scenario));
    }
    const changes = changedSpeeds
      .slice(1)
      .map((speed, index) => Math.abs(speed - changedSpeeds[index]));
    expect(changedSpeeds[0]).toBeCloseTo(12, 5);
    expect(changedSpeeds[1]).toBeLessThan(12);
    expect(Math.max(...changes)).toBeLessThan(1.3);
    expect(changedSpeeds[4]).toBeCloseTo(7, 5);
    expect(changedSpeeds.slice(4)).toEqual(
      expect.arrayContaining([expect.closeTo(7, 5), expect.closeTo(7, 5)]),
    );
  });

  it("withholds arrival during a same-heading rollercoaster", () => {
    const speeds = [8, 8, 18, 18];
    const climbRates = [-2.5, -2.5, 2.5, 2.5];
    const fixes: Fix[] = [];
    let latitude = 43.03;
    for (let index = 0; index < 24; index++) {
      const speed = speeds[index % speeds.length];
      latitude -= speed / METERS_PER_LATITUDE_DEGREE;
      fixes.push({
        timestamp: index * 1000,
        latitude,
        longitude: -89,
        altitude: 300,
        speed,
        course: 180,
        climbRate: climbRates[index % climbRates.length],
        horizontalAccuracy: 3,
        verticalAccuracy: 5,
      });
    }

    const etas = fixes
      .slice(12)
      .map((_, index) =>
        deriveNavigationGuidance(fixes.slice(0, index + 13), launch),
      );

    expect(etas.every((guidance) => guidance?.etaSeconds === null)).toBe(true);
  });

  it("holds calibration through a turn and hands off without a speed jump", () => {
    const scenario = scenarioWithHeadingCoverage();
    appendDirect(scenario, 7, 18);
    const calibrated = returnSpeed(scenario);
    expect(calibrated).toBeCloseTo(7, 5);

    append(scenario, velocityFromAir(90, 12, 0, 5), 1);
    expect(returnSpeed(scenario)).toBeCloseTo(calibrated, 1);

    const modeledSpeeds: number[] = [];
    const models: {
      candidates: (number | null)[];
      speed: number;
      windowMinutes: number;
    }[] = [];
    for (let sample = 0; sample < 120; sample++) {
      append(scenario, velocityFromAir((sample * 15) % 360, 12, 0, 5), 15);
      modeledSpeeds.push(returnSpeed(scenario));
      const targetCourse = bearingBetween(
        scenario.fixes[scenario.fixes.length - 1],
        launch,
      );
      const model = estimateAdaptiveReturnSpeed(scenario.fixes, targetCourse)!;
      models.push({
        candidates: [5, 10, 15, 30].map(
          (minutes) =>
            estimateReturnSpeed(scenario.fixes, targetCourse, minutes * 60_000)
              ?.conservativeMetersPerSecond ?? null,
        ),
        speed: model.conservativeMetersPerSecond,
        windowMinutes: model.windowMs / 60_000,
      });
    }
    const jumps = modeledSpeeds
      .slice(1)
      .map((speed, index) => Math.abs(speed - modeledSpeeds[index]));
    const maximumJump = Math.max(...jumps);
    const jumpIndex = jumps.indexOf(maximumJump);
    expect(
      maximumJump,
      JSON.stringify({
        after: modeledSpeeds[jumpIndex + 1],
        before: modeledSpeeds[jumpIndex],
        jumpIndex,
        models: models.slice(jumpIndex - 1, jumpIndex + 3),
      }),
    ).toBeLessThan(0.5);

    const targetCourse = bearingBetween(
      scenario.fixes[scenario.fixes.length - 1],
      launch,
    );
    const model = estimateAdaptiveReturnSpeed(scenario.fixes, targetCourse)!;
    expect(model.windowMs).toBe(30 * 60_000);
    expect(modeledSpeeds[modeledSpeeds.length - 1]).toBeCloseTo(
      model.conservativeMetersPerSecond,
      1,
    );
  });
});
