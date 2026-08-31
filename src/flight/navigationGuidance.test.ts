import { describe, expect, it } from "vitest";

import type { Fix } from "../engine/types";
import { bearingBetween } from "./nav";
import {
  deriveNavigationGuidance,
  type NavigationTarget,
} from "./navigationGuidance";
import { sunsetNear } from "./sun";

const launch: NavigationTarget = {
  kind: "launch",
  latitude: 43,
  longitude: -89,
};

function fix(
  timestamp: number,
  latitude: number,
  longitude: number,
  course: number,
  speed = 12,
): Fix {
  return {
    timestamp,
    latitude,
    longitude,
    altitude: 300,
    speed,
    course,
    climbRate: 0,
    horizontalAccuracy: 3,
    verticalAccuracy: 5,
  };
}

function inboundTrack(
  errorDegrees: number,
  seconds = 13,
  startedAt = 0,
): Fix[] {
  return Array.from({ length: seconds }, (_, index) => {
    const latitude = 43 + 0.03 - index * 0.0001;
    const point = { latitude, longitude: -89 };
    const course = bearingBetween(point, launch) + errorDegrees;
    return fix(startedAt + index * 1000, latitude, -89, course);
  });
}

describe("deriveNavigationGuidance", () => {
  it("shows the edge on the side of a persistent small correction", () => {
    const guidance = deriveNavigationGuidance(inboundTrack(8), launch);
    expect(guidance?.directionHint).toBe("left");
    expect(
      deriveNavigationGuidance(inboundTrack(-8), launch)?.directionHint,
    ).toBe("right");
  });

  it("shows nothing when aligned, far off, inside a mile, or targeting a waypoint", () => {
    expect(
      deriveNavigationGuidance(inboundTrack(2), launch)?.directionHint,
    ).toBeNull();
    expect(
      deriveNavigationGuidance(inboundTrack(25), launch)?.directionHint,
    ).toBeNull();
    const close = inboundTrack(8).map((sample) => ({
      ...sample,
      latitude: 43.005,
    }));
    expect(deriveNavigationGuidance(close, launch)?.directionHint).toBeNull();
    expect(
      deriveNavigationGuidance(inboundTrack(8), {
        ...launch,
        kind: "waypoint",
      })?.directionHint,
    ).toBeNull();
  });

  it("suppresses the hint while the pilot is already correcting", () => {
    const track = inboundTrack(10).map((sample, index) => {
      const point = {
        latitude: sample.latitude,
        longitude: sample.longitude,
      };
      return {
        ...sample,
        course: bearingBetween(point, launch) + 10 - index * 0.4,
      };
    });
    expect(deriveNavigationGuidance(track, launch)?.directionHint).toBeNull();
    const turning = inboundTrack(8).map((sample, index) => {
      const point = {
        latitude: sample.latitude,
        longitude: sample.longitude,
      };
      return {
        ...sample,
        course: bearingBetween(point, launch) + (index % 2 === 0 ? 8 : 12),
      };
    });
    expect(deriveNavigationGuidance(turning, launch)?.directionHint).toBeNull();
  });

  it("suppresses the hint for gaps, poor accuracy, and movement away", () => {
    const withGap = inboundTrack(8).map((sample, index) => ({
      ...sample,
      timestamp: index < 7 ? sample.timestamp : sample.timestamp + 4000,
    }));
    const inaccurate = inboundTrack(8).map((sample, index) => ({
      ...sample,
      horizontalAccuracy: index === 7 ? 150 : sample.horizontalAccuracy,
    }));
    const movingAway = inboundTrack(8).map((sample, index) => {
      const latitude = 43.03 + index * 0.0001;
      const point = { latitude, longitude: sample.longitude };
      return {
        ...sample,
        latitude,
        course: bearingBetween(point, launch) + 8,
      };
    });
    expect(deriveNavigationGuidance(withGap, launch)?.directionHint).toBeNull();
    expect(
      deriveNavigationGuidance(inaccurate, launch)?.directionHint,
    ).toBeNull();
    expect(
      deriveNavigationGuidance(movingAway, launch)?.directionHint,
    ).toBeNull();
  });

  it("waits for the 1.2 mile rearm distance before hinting", () => {
    const underRearm = Array.from({ length: 13 }, (_, index) => {
      const latitude = 43.017 - index * 0.0001;
      const point = { latitude, longitude: -89 };
      return fix(
        index * 1000,
        latitude,
        -89,
        bearingBetween(point, launch) + 8,
      );
    });
    expect(
      deriveNavigationGuidance(underRearm, launch)?.directionHint,
    ).toBeNull();
    const rearmed = [fix(-1000, 43.0185, -89, 180), ...underRearm];
    expect(deriveNavigationGuidance(rearmed, launch)?.directionHint).toBe(
      "left",
    );
  });

  it("does not show a morning sunset reference", () => {
    const morning = fix(Date.UTC(2026, 6, 18, 15), 43.03, -89, 180);
    expect(deriveNavigationGuidance([morning], launch)?.sunsetAt).toBeNull();
  });

  it("falls back to radial groundspeed while already pointed at a target", () => {
    const point = { latitude: 43.03, longitude: -89 };
    const course = bearingBetween(point, launch);
    const guidance = deriveNavigationGuidance(
      [fix(0, point.latitude, point.longitude, course, 12)],
      launch,
    );
    expect(guidance?.etaSeconds).toBeCloseTo(guidance!.distanceMeters / 12);
  });

  it("quickly follows measured groundspeed after inbound flight is stable", () => {
    const track = inboundTrack(0).map((sample, index) => ({
      ...sample,
      speed: index < 8 ? 18 : 6,
    }));
    const guidance = deriveNavigationGuidance(track, launch)!;
    expect(guidance.etaSeconds).toBeCloseTo(guidance.distanceMeters / 6);
  });

  it("uses target-course groundspeed before the full inbound gate", () => {
    const track = inboundTrack(0, 3).map((sample) => ({
      ...sample,
      speed: 7,
    }));

    const guidance = deriveNavigationGuidance(track, launch)!;

    expect(guidance.etaSeconds).toBeCloseTo(guidance.distanceMeters / 7);
  });

  it("retains a recent inbound calibration after turning away", () => {
    const inbound = inboundTrack(0).map((sample) => ({
      ...sample,
      speed: 6,
    }));
    const turnedAway = {
      ...inbound[inbound.length - 1],
      course: 90,
      timestamp: inbound[inbound.length - 1].timestamp + 1000,
    };
    const guidance = deriveNavigationGuidance(
      [...inbound, turnedAway],
      launch,
    )!;
    expect(guidance.etaSeconds).toBeCloseTo(guidance.distanceMeters / 6);
  });

  it("replaces an old calibration after a stable target-course handoff", () => {
    const inbound = inboundTrack(0).map((sample) => ({
      ...sample,
      speed: 12,
    }));
    const last = inbound[inbound.length - 1];
    const turnedAway = {
      ...last,
      course: 90,
      timestamp: last.timestamp + 1000,
    };
    const refreshed = Array.from({ length: 8 }, (_, index) => {
      const latitude = last.latitude - index * 0.0001;
      const point = { latitude, longitude: last.longitude };
      return fix(
        turnedAway.timestamp + (index + 1) * 1000,
        latitude,
        last.longitude,
        bearingBetween(point, launch),
        7,
      );
    });

    const guidance = deriveNavigationGuidance(
      [...inbound, turnedAway, ...refreshed],
      launch,
    )!;

    expect(guidance.etaSeconds).toBeCloseTo(guidance.distanceMeters / 7);
  });

  it("rejects an isolated inbound speed spike", () => {
    const track = inboundTrack(0).map((sample, index) => ({
      ...sample,
      speed: index === 12 ? 30 : 6,
    }));
    const guidance = deriveNavigationGuidance(track, launch)!;
    expect(guidance.etaSeconds).toBeCloseTo(guidance.distanceMeters / 6);
  });

  it("uses one sunset reference for now and projected arrival", () => {
    const sunset = sunsetNear(
      new Date(Date.UTC(2026, 6, 18, 18)),
      launch.latitude,
      launch.longitude,
    )!;
    const track = inboundTrack(0, 13, sunset.getTime() - 3 * 60_000 - 12_000);
    const guidance = deriveNavigationGuidance(track, launch)!;
    expect(guidance.sunsetAt).toBe(sunset.getTime());
    expect(guidance.sunsetOffsetMs).toBe(-3 * 60_000);
    expect(guidance.arrivalSunsetOffsetMs).toBeCloseTo(
      guidance.sunsetOffsetMs! + guidance.etaSeconds! * 1000,
    );
  });

  it("keeps sunset visible after crossing it but not on a later launch", () => {
    const sunset = sunsetNear(
      new Date(Date.UTC(2026, 6, 18, 18)),
      launch.latitude,
      launch.longitude,
    )!;
    const crossed = [
      fix(sunset.getTime() - 45 * 60_000, 43.03, -89, 180),
      fix(sunset.getTime() + 4 * 60 * 60_000, 43.03, -89, 180),
    ];
    const launchedLater = [
      fix(sunset.getTime() + 10 * 60_000, 43.03, -89, 180),
      fix(sunset.getTime() + 20 * 60_000, 43.03, -89, 180),
    ];
    expect(deriveNavigationGuidance(crossed, launch)?.sunsetAt).toBe(
      sunset.getTime(),
    );
    expect(
      deriveNavigationGuidance(launchedLater, launch)?.sunsetAt,
    ).toBeNull();
  });
});
