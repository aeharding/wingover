import { describe, expect, it } from "vitest";

import { sunFactLabel, sunriseNear, sunsetNear } from "./sun";

const hourUtc = (d: Date) => d.getUTCHours() + d.getUTCMinutes() / 60;

describe("sunsetNear", () => {
  it("equator sunset is ~18:00 local solar time year round", () => {
    for (const month of [0, 3, 6, 9]) {
      const sunset = sunsetNear(new Date(Date.UTC(2026, month, 15, 12)), 0, 0);
      expect(sunset).not.toBeNull();
      expect(hourUtc(sunset!)).toBeGreaterThan(17.5);
      expect(hourUtc(sunset!)).toBeLessThan(18.5);
    }
  });

  it("London sunsets late in June, early in December", () => {
    const june = sunsetNear(new Date(Date.UTC(2026, 5, 21, 12)), 51.5, 0);
    const december = sunsetNear(new Date(Date.UTC(2026, 11, 21, 12)), 51.5, 0);
    expect(hourUtc(june!)).toBeGreaterThan(19.5);
    expect(hourUtc(june!)).toBeLessThan(21);
    expect(hourUtc(december!)).toBeGreaterThan(15.25);
    expect(hourUtc(december!)).toBeLessThan(16.5);
  });

  it("longitude shifts sunset in UTC, not in local solar time", () => {
    const greenwich = sunsetNear(new Date(Date.UTC(2026, 8, 1, 12)), 45, 0);
    const west90 = sunsetNear(new Date(Date.UTC(2026, 8, 1, 18)), 45, -90);
    const shiftHours =
      (west90!.getTime() - greenwich!.getTime()) / (1000 * 60 * 60);
    expect(shiftHours).toBeGreaterThan(5.5);
    expect(shiftHours).toBeLessThan(6.5);
  });

  it("polar day and night have no sunset", () => {
    expect(sunsetNear(new Date(Date.UTC(2026, 5, 21, 12)), 78.2, 15.6)).toBe(
      null,
    );
    expect(sunsetNear(new Date(Date.UTC(2026, 11, 21, 12)), 78.2, 15.6)).toBe(
      null,
    );
  });

  it("sunrise precedes sunset within the same solar day", () => {
    const at = new Date(Date.UTC(2026, 8, 1, 12));
    const rise = sunriseNear(at, 45, 0);
    const set = sunsetNear(at, 45, 0);
    expect(rise!.getTime()).toBeLessThan(set!.getTime());
    expect(set!.getTime() - rise!.getTime()).toBeGreaterThan(10 * 3600000);
    expect(set!.getTime() - rise!.getTime()).toBeLessThan(15 * 3600000);
  });
});

describe("sunFactLabel", () => {
  // Anchor every phase off the day's own computed events so the tests
  // hold at any location; lat 45, lng 0, an equinox-ish day.
  const anchor = new Date(Date.UTC(2026, 8, 1, 12));
  const rise = sunriseNear(anchor, 45, 0)!;
  const set = sunsetNear(anchor, 45, 0)!;
  const HOUR = 3600000;
  const at = (base: Date, hours: number) =>
    sunFactLabel(new Date(base.getTime() + hours * HOUR), 45, 0);

  it("far from sunset: absolute clock time", () => {
    const label = at(set, -5)!;
    expect(label).toMatch(/^Sunset /);
    expect(label).not.toContain(" in ");
    expect(label).not.toContain(" ago");
  });

  it("inside 4h of sunset: relative countdown", () => {
    expect(at(set, -2)).toBe("Sunset in 2h");
    expect(at(set, -3.5)).toBe("Sunset in 3h 30m");
  });

  it("up to 30m past sunset: time since", () => {
    expect(at(set, 0.25)).toBe("Sunset 15m ago");
  });

  it("night: absolute sunrise until 120m out, then countdown", () => {
    const night = at(set, 1)!;
    expect(night).toMatch(/^Sunrise /);
    expect(night).not.toContain(" in ");
    const nextRise = sunriseNear(
      new Date(set.getTime() + 12 * HOUR),
      45,
      0,
    )!;
    expect(sunFactLabel(new Date(nextRise.getTime() - HOUR), 45, 0)).toBe(
      "Sunrise in 1h",
    );
  });

  it("up to 6h past sunrise: time since, then back to sunset", () => {
    expect(at(rise, 2)).toBe("Sunrise 2h ago");
    const midday = at(rise, 6.5)!;
    expect(midday).toMatch(/^Sunset /);
    expect(midday).not.toContain(" ago");
  });

  it("polar night falls back to null", () => {
    expect(sunFactLabel(new Date(Date.UTC(2026, 11, 21, 12)), 78.2, 15.6)).toBe(
      null,
    );
  });
});
