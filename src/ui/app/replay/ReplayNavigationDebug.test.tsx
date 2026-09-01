import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Fix } from "../../../engine/types";
import { formatSunsetOffset } from "../../../flight/format";
import { sunsetNear } from "../../../flight/sun";
import ReplayNavigationDebug from "./ReplayNavigationDebug";

function circleTrack(): Fix[] {
  return Array.from({ length: 24 }, (_, index) => ({
    timestamp: index * 15_000,
    latitude: 43,
    longitude: -89,
    altitude: 300,
    speed: 12,
    course: index * 15,
    climbRate: 0,
    horizontalAccuracy: 3,
    verticalAccuracy: 5,
  }));
}

describe("ReplayNavigationDebug", () => {
  it("shows a whole-minute model window", () => {
    const html = renderToStaticMarkup(
      <ReplayNavigationDebug track={circleTrack()} units="imperial" />,
    );

    expect(html).toMatch(/Model<\/span><strong>[^<]+ · \d+m<\/strong>/);
    expect(html).not.toMatch(/ · \d+\.\d+m/);
  });

  it("calculates raw sunset at the playhead coordinates", () => {
    const at = Date.UTC(2026, 6, 18, 23);
    const track = circleTrack().map((sample, index, samples) => ({
      ...sample,
      timestamp: at - (samples.length - 1 - index) * 15_000,
    }));
    track[track.length - 1] = {
      ...track[track.length - 1],
      longitude: -99,
    };
    const latest = track[track.length - 1];
    const currentSunset = sunsetNear(
      new Date(latest.timestamp),
      latest.latitude,
      latest.longitude,
    )!.getTime();
    const launchSunset = sunsetNear(
      new Date(latest.timestamp),
      track[0].latitude,
      track[0].longitude,
    )!.getTime();
    const currentValue = formatSunsetOffset(latest.timestamp - currentSunset);
    const launchValue = formatSunsetOffset(latest.timestamp - launchSunset);

    const html = renderToStaticMarkup(
      <ReplayNavigationDebug track={track} units="imperial" />,
    );

    expect(currentValue).not.toBe(launchValue);
    expect(html).toContain(currentValue);
    expect(html).not.toContain(
      `<span>Sunset raw</span><strong>${launchValue}</strong>`,
    );
  });
});
