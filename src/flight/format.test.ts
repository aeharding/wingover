import { describe, expect, it } from "vitest";

import {
  formatAltitude,
  formatClimb,
  formatDistance,
  formatDuration,
  formatRelativeDegrees,
  formatSpeed,
} from "./format";

describe("format", () => {
  it("formats altitude", () => {
    expect(formatAltitude(625, "imperial")).toBe("2,051 ft");
    expect(formatAltitude(625, "metric")).toBe("625 m");
  });

  it("formats speed", () => {
    expect(formatSpeed(13, "imperial")).toBe("29.1 mph");
    expect(formatSpeed(13, "metric")).toBe("46.8 km/h");
  });

  it("formats climb with sign", () => {
    expect(formatClimb(1.5, "imperial")).toBe("+4.9 ft/s");
    expect(formatClimb(-1.5, "metric")).toBe("-1.5 m/s");
  });

  it("formats distance with hundredths precision", () => {
    expect(formatDistance(10827, "imperial")).toBe("6.73 mi");
    expect(formatDistance(10827, "metric")).toBe("10.83 km");
    expect(formatDistance(1572303, "imperial")).toBe("976.98 mi");
    expect(formatDistance(800, "metric")).toBe("0.80 km");
  });

  it("formats relative degrees with sign", () => {
    expect(formatRelativeDegrees(-19.4)).toBe("-19°");
    expect(formatRelativeDegrees(142.6)).toBe("+143°");
    expect(formatRelativeDegrees(0)).toBe("0°");
  });

  it("formats duration", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(199)).toBe("3:19");
    expect(formatDuration(3661)).toBe("1:01:01");
  });
});
