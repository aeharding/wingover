import { describe, expect, it } from "vitest";

import {
  DEFAULT_FLIGHT_ZOOM,
  REFERENCE_WIDTH_PX,
  zoomSpanBounds,
} from "./ZoomControl";

describe("the flight's arrival zoom", () => {
  it("sits in the middle of the zoom strip", () => {
    const { min, max } = zoomSpanBounds(0, REFERENCE_WIDTH_PX);

    expect(DEFAULT_FLIGHT_ZOOM).toBeCloseTo((min + max) / 2, 6);
  });

  it("frames a few kilometres of ground, not a continent", () => {
    expect(DEFAULT_FLIGHT_ZOOM).toBeGreaterThan(12);
    expect(DEFAULT_FLIGHT_ZOOM).toBeLessThan(15);
  });
});
