import { describe, expect, it } from "vitest";

import {
  flightTitle,
  formatAirtime,
  formatAltitude,
  formatClimb,
  formatDistance,
  formatDuration,
  formatFlightDate,
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
    expect(formatDistance(17203868, "imperial")).toBe("10,689.99 mi");
    expect(formatDistance(17203868, "metric")).toBe("17,203.87 km");
    expect(formatDistance(800, "metric")).toBe("0.80 km");
  });

  it("formats the logbook row date: weekday this year, year after that", () => {
    const now = new Date("2026-07-16T12:00:00");
    expect(
      formatFlightDate(new Date("2026-07-12T06:42:00").getTime(), now),
    ).toBe("Sun, Jul 12 · 6:42 AM");
    expect(
      formatFlightDate(new Date("2025-10-03T18:05:00").getTime(), now),
    ).toBe("Oct 3, 2025 · 6:05 PM");
  });

  it("formats logged airtime in words, floored", () => {
    expect(formatAirtime(45)).toBe("45 sec");
    expect(formatAirtime(59.9)).toBe("59 sec");
    expect(formatAirtime(60)).toBe("1 min");
    expect(formatAirtime(3345)).toBe("55 min");
    expect(formatAirtime(5662)).toBe("1 hr 34 min");
    expect(formatAirtime(1722181)).toBe("478 hr 23 min");
    expect(formatAirtime(7200)).toBe("2 hr");
    expect(formatAirtime(3_600_000)).toBe("1,000 hr");
  });

  it("titles a flight: name, else launch site, else date", () => {
    const base = { startedAt: new Date("2026-07-12T06:42:00").getTime() };
    expect(flightTitle({ ...base, name: "Sunset ridge" })).toBe(
      "Sunset ridge",
    );
    expect(flightTitle({ ...base, name: "", launchName: "Madcity" })).toBe(
      "Madcity",
    );
    expect(flightTitle({ ...base, name: "" })).toMatch(/Jul 12 · 6:42 AM$/);
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
