import { describe, expect, it } from "vitest";

import {
  etaDisplayMinutes,
  formatArrivalSunsetOffset,
  formatEta,
  formatNavigationDistance,
  formatSunsetOffset,
} from "./format";

describe("navigation time formatting", () => {
  it("formats ordinary ETA without a sign", () => {
    expect(etaDisplayMinutes(12 * 60 + 1)).toBe(13);
    expect(formatEta(12 * 60)).toBe(":12");
    expect(formatEta(12 * 60 + 1)).toBe(":13");
    expect(formatEta(65 * 60)).toBe("1:05");
  });

  it("reduces navigation precision as distance grows", () => {
    expect(formatNavigationDistance(9.87 * 1609.344, "imperial")).toBe(
      "9.87 mi",
    );
    expect(formatNavigationDistance(10.3 * 1609.344, "imperial")).toBe(
      "10.3 mi",
    );
    expect(formatNavigationDistance(103 * 1609.344, "imperial")).toBe("103 mi");
    expect(formatNavigationDistance(9.999 * 1609.344, "imperial")).toBe(
      "10.0 mi",
    );
    expect(formatNavigationDistance(99.96 * 1609.344, "imperial")).toBe(
      "100 mi",
    );
    expect(formatNavigationDistance(10_300, "metric")).toBe("10.3 km");
  });

  it("counts down to sunset and elapsed time after it", () => {
    expect(formatSunsetOffset(-181_000)).toBe("S−04");
    expect(formatSunsetOffset(-180_000)).toBe("S−03");
    expect(formatSunsetOffset(179_000)).toBe("S+02");
  });

  it("rounds projected arrival toward the later minute", () => {
    expect(formatArrivalSunsetOffset(-181_000)).toBe("S−03");
    expect(formatArrivalSunsetOffset(121_000)).toBe("S+03");
    expect(formatArrivalSunsetOffset(-1)).toBe("S−00");
    expect(formatArrivalSunsetOffset(0)).toBe("S+00");
  });
});
