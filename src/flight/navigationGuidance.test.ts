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

  it("acquires inbound guidance with ordinary fix timestamp jitter", () => {
    const fasterCadence = inboundTrack(8, 14).map((sample, index) => ({
      ...sample,
      timestamp: index * 999,
    }));
    const slowerCadence = inboundTrack(8, 13).map((sample, index) => ({
      ...sample,
      timestamp: index * 1001,
    }));

    expect(deriveNavigationGuidance(fasterCadence, launch)?.directionHint).toBe(
      "left",
    );
    expect(deriveNavigationGuidance(slowerCadence, launch)?.directionHint).toBe(
      "left",
    );
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

  it("keeps ETA while a strong headwind reduces groundspeed below five meters per second", () => {
    const track = inboundTrack(0).map((sample) => ({ ...sample, speed: 4 }));

    const guidance = deriveNavigationGuidance(track, launch)!;

    expect(guidance.etaSeconds).toBeCloseTo(guidance.distanceMeters / 4);
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

  it("retains direct evidence for thirty minutes without a circle model", () => {
    const direct = inboundTrack(0, 7).map((sample) => ({
      ...sample,
      speed: 6,
    }));
    const last = direct[direct.length - 1];
    const afterFifteenMinutes = {
      ...last,
      course: 90,
      timestamp: last.timestamp + 15 * 60_000,
    };
    const afterThirtyOneMinutes = {
      ...afterFifteenMinutes,
      timestamp: last.timestamp + 31 * 60_000,
    };

    const retained = deriveNavigationGuidance(
      [...direct, afterFifteenMinutes],
      launch,
    )!;
    const expired = deriveNavigationGuidance(
      [...direct, afterThirtyOneMinutes],
      launch,
    )!;

    expect(retained.etaSeconds).toBeCloseTo(retained.distanceMeters / 6);
    expect(expired.etaSeconds).toBeNull();
  });

  it("fades historical direct evidence as the target bearing changes", () => {
    const historical = inboundTrack(0, 7).map((sample) => ({
      ...sample,
      latitude: 43.03,
      longitude: -89,
      course: 180,
      speed: 6,
    }));
    const moved = {
      ...historical[historical.length - 1],
      longitude: -88.988,
      course: 90,
      timestamp: historical[historical.length - 1].timestamp + 1000,
    };

    const guidance = deriveNavigationGuidance([...historical, moved], launch)!;

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
    const geometry = inboundTrack(0);
    const endpoint = geometry[geometry.length - 1];
    const sunset = sunsetNear(
      new Date(Date.UTC(2026, 6, 18, 18)),
      endpoint.latitude,
      endpoint.longitude,
    )!;
    const track = [
      fix(sunset.getTime() - 60 * 60_000, 43, -89, 180),
      ...inboundTrack(0, 13, sunset.getTime() - 3 * 60_000 - 12_000),
    ];
    const guidance = deriveNavigationGuidance(track, launch)!;
    expect(guidance.sunsetAt).toBe(sunset.getTime());
    expect(guidance.sunsetOffsetMs).toBe(-3 * 60_000);
    expect(guidance.arrivalSunsetOffsetMs).toBeCloseTo(
      guidance.sunsetOffsetMs! + guidance.etaSeconds! * 1000,
    );
  });

  it("shows sunset from thirty minutes before through one hour after", () => {
    const sunset = sunsetNear(
      new Date(Date.UTC(2026, 6, 18, 18)),
      launch.latitude,
      launch.longitude,
    )!;
    const launchedAfterSunset = [
      fix(sunset.getTime() + 10 * 60_000, 43, -89, 180),
      fix(sunset.getTime() + 20 * 60_000, 43, -89, 180),
    ];
    const tooEarly = [fix(sunset.getTime() - 40 * 60_000, 43, -89, 180)];
    const tooLate = [fix(sunset.getTime() + 61 * 60_000, 43, -89, 180)];

    expect(
      deriveNavigationGuidance(launchedAfterSunset, launch)?.sunsetAt,
    ).toBe(sunset.getTime());
    expect(deriveNavigationGuidance(tooEarly, launch)?.sunsetAt).toBeNull();
    expect(deriveNavigationGuidance(tooLate, launch)?.sunsetAt).toBeNull();
  });

  it("keeps the sunset reference stable when a waypoint changes", () => {
    const sunset = sunsetNear(
      new Date(Date.UTC(2026, 8, 1)),
      launch.latitude,
      launch.longitude,
    )!;
    const track = [
      fix(sunset.getTime() - 28 * 60_000, 43, -89, 180),
      fix(sunset.getTime() - 27 * 60_000, 43.03, -89, 180),
    ];
    const waypoint: NavigationTarget = {
      kind: "waypoint",
      latitude: 43,
      longitude: -90,
    };

    expect(deriveNavigationGuidance(track, waypoint)?.sunsetAt).toBe(
      deriveNavigationGuidance(track, launch)?.sunsetAt,
    );
  });
});
