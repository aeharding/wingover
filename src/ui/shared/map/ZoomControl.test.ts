import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_FLIGHT_SPAN_M,
  defaultFlightZoom,
  zoomSpanBounds,
} from "./ZoomControl";

// The widths the strip measures itself against, across the screens the app
// runs on: phone portrait, phone landscape, iPad, desktop PWA.
const WIDTHS = [390, 844, 1024, 1728];
const LATITUDES = [0, 33.4, 47.6, 61.2];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the zoom a flight opens on", () => {
  it("sits mid-strip on every screen and at every latitude", () => {
    for (const innerWidth of WIDTHS) {
      vi.stubGlobal("window", { innerWidth });
      for (const latitude of LATITUDES) {
        const { min, max } = zoomSpanBounds(latitude, innerWidth);

        expect(defaultFlightZoom(latitude)).toBeCloseTo((min + max) / 2, 6);
      }
    }
  });

  it("frames a few kilometres of ground, not a continent", () => {
    expect(DEFAULT_FLIGHT_SPAN_M).toBeGreaterThan(2_000);
    expect(DEFAULT_FLIGHT_SPAN_M).toBeLessThan(10_000);
  });
});
