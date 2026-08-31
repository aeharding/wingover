import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Fix, Waypoint } from "../../engine/types";
import type { NavigationGuidance } from "../../flight/navigationGuidance";
import InstrumentsStrip from "./InstrumentsStrip";

const first: Fix = {
  timestamp: 0,
  latitude: 43,
  longitude: -89,
  altitude: 300,
  speed: 12,
  course: 180,
  climbRate: 0,
  horizontalAccuracy: 3,
  verticalAccuracy: 5,
};

const latest: Fix = {
  ...first,
  timestamp: 12 * 60_000,
  latitude: 43.03,
  altitude: 450,
};

function guidance(
  overrides: Partial<NavigationGuidance> = {},
): NavigationGuidance {
  return {
    distanceMeters: 3218.688,
    directionDegrees: -8,
    etaSeconds: 12 * 60,
    sunsetAt: null,
    sunsetOffsetMs: null,
    arrivalSunsetOffsetMs: null,
    directionHint: null,
    ...overrides,
  };
}

function renderStrip(
  navigation: NavigationGuidance,
  nextWaypoint: Waypoint | null = null,
) {
  return renderToStaticMarkup(
    <InstrumentsStrip
      ref={createRef<HTMLDivElement>()}
      latest={latest}
      first={first}
      nextWaypoint={nextWaypoint}
      guidance={navigation}
      units="imperial"
    />,
  );
}

function classesFor(html: string, testId: string): string {
  const match = html.match(
    new RegExp(`<div class="([^"]+)" data-testid="${testId}"`),
  );
  return match?.[1] ?? "";
}

describe("InstrumentsStrip navigation", () => {
  it("adds an unsigned ETA without adding a ninth primary stat", () => {
    const html = renderStrip(guidance());
    expect(html).toContain("To launch");
    expect(html).toContain('data-testid="instrument-target-eta"');
    expect(html).toContain(":12");
    expect(html).not.toContain("Sunset");
    expect(html.match(/data-tile-value/g)).toHaveLength(8);
  });

  it("uses matching magenta text for current and arrival sunset offsets", () => {
    const html = renderStrip(
      guidance({
        sunsetAt: latest.timestamp + 3 * 60_000,
        sunsetOffsetMs: -3 * 60_000,
        arrivalSunsetOffsetMs: 2 * 60_000,
      }),
    );
    expect(html).toContain("Sunset");
    expect(html).toContain("sunsetMinus_");
    expect(html.replace(/<[^>]+>/g, "")).toContain("S−03");
    expect(html).toContain("S+02");
    expect(classesFor(html, "instrument-sunset")).toBe(
      classesFor(html, "instrument-target-arrival-sunset"),
    );
    expect(html).not.toContain('data-testid="instrument-target-eta"');
    expect(html.match(/data-tile-value/g)).toHaveLength(8);
  });

  it("uses the same compact ETA treatment for a waypoint", () => {
    const html = renderStrip(guidance(), {
      id: "waypoint-1",
      latitude: 43.02,
      longitude: -89,
      radiusM: 100,
    });
    expect(html).toContain("To waypoint");
    expect(html).toContain('data-testid="instrument-target-eta"');
  });

  it("hides launch arrival data within one mile", () => {
    const html = renderStrip(
      guidance({
        distanceMeters: 1609,
        etaSeconds: 4 * 60,
        sunsetAt: latest.timestamp + 10 * 60_000,
        sunsetOffsetMs: -10 * 60_000,
        arrivalSunsetOffsetMs: -6 * 60_000,
      }),
    );
    expect(html).toContain('data-testid="instrument-target-distance"');
    expect(html).not.toContain('data-testid="instrument-target-eta"');
    expect(html).not.toContain(
      'data-testid="instrument-target-arrival-sunset"',
    );
    expect(html).toContain('data-sunset-guidance="true"');
  });

  it("hides arrival data within one minute for every target", () => {
    const navigation = guidance({ etaSeconds: 60 });
    const launch = renderStrip(navigation);
    const waypoint = renderStrip(navigation, {
      id: "waypoint-1",
      latitude: 43.02,
      longitude: -89,
      radiusM: 100,
    });
    expect(launch).not.toContain('data-testid="instrument-target-eta"');
    expect(waypoint).not.toContain('data-testid="instrument-target-eta"');
  });

  it("keeps a waypoint ETA visible when it is close but over one minute", () => {
    const html = renderStrip(
      guidance({ distanceMeters: 1200, etaSeconds: 2 * 60 }),
      {
        id: "waypoint-1",
        latitude: 43.02,
        longitude: -89,
        radiusM: 100,
      },
    );
    expect(html).toContain('data-testid="instrument-target-eta"');
  });
});
