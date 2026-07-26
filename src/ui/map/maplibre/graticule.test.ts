import { describe, expect, it } from "vitest";

import { gridForZoom } from "./graticule";

const VIEWPORT_PX = 390; // a phone

describe("gridForZoom", () => {
  it("halves the spacing every zoom level", () => {
    for (let zoom = 10; zoom < 18; zoom++) {
      const here = gridForZoom(zoom, VIEWPORT_PX).spacing;
      const next = gridForZoom(zoom + 1, VIEWPORT_PX).spacing;
      expect(next).toBeCloseTo(here / 2, 12);
    }
  });

  // The whole point of the fade: at the instant spacing halves, the
  // subdivision is already solid and simply BECOMES the established grid, so
  // the rendered result is unchanged across the flip. If fade did not reach 1
  // first, the grid would visibly pop.
  it("reaches full opacity immediately before a band flip", () => {
    for (let zoom = 10; zoom < 18; zoom += 0.5) {
      const { spacing } = gridForZoom(zoom, VIEWPORT_PX);
      const nudged = gridForZoom(zoom + 0.001, VIEWPORT_PX);
      if (nudged.spacing === spacing) continue;
      expect(gridForZoom(zoom, VIEWPORT_PX).fade).toBeGreaterThan(0.99);
      expect(nudged.fade).toBeLessThan(0.01);
    }
  });

  it("fades monotonically from 0 to 1 across a whole band", () => {
    // Band edges do not fall on integer zooms, so walk until one starts
    // rather than assuming where it is.
    const step = 0.01;
    let zoom = 14;
    const before = gridForZoom(zoom, VIEWPORT_PX).spacing;
    while (gridForZoom(zoom, VIEWPORT_PX).spacing === before) zoom += step;

    const band: number[] = [];
    const spacing = gridForZoom(zoom, VIEWPORT_PX).spacing;
    while (gridForZoom(zoom, VIEWPORT_PX).spacing === spacing) {
      band.push(gridForZoom(zoom, VIEWPORT_PX).fade);
      zoom += step;
    }

    expect(band.length).toBeGreaterThan(50);
    expect(band[0]!).toBeLessThan(0.01);
    // The final sample sits up to one step short of the flip, so it lands a
    // shade under 1; the exact boundary is pinned by the test above.
    expect(band.at(-1)!).toBeGreaterThan(0.98);
    for (let i = 1; i < band.length; i++) {
      expect(band[i]!).toBeGreaterThanOrEqual(band[i - 1]!);
    }
  });

  it("keeps the grid at a usable density across every flying zoom", () => {
    for (let zoom = 8; zoom <= 18; zoom += 0.25) {
      const { spacing } = gridForZoom(zoom, VIEWPORT_PX);
      const worldSize = 512 * 2 ** zoom;
      const cellsAcross = VIEWPORT_PX / worldSize / spacing;
      // Established cells only; the subdivision doubles this mid-fade.
      expect(cellsAcross).toBeGreaterThan(2);
      expect(cellsAcross).toBeLessThanOrEqual(6);
    }
  });
});
