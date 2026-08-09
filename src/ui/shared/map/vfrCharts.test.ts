import { describe, expect, it } from "vitest";

import { pinnedTemplate, selectChart } from "./vfrCharts";

const EFFECTIVE = "2026-09-03T09:01:00Z";
const EFFECTIVE_MS = Date.parse(EFFECTIVE);

const CURRENT_TILES =
  "https://charts.wingover.app/vfr/2026-07-09/3x/{z}/{x}/{y}.jxl";
const NEXT_TILES =
  "https://charts.wingover.app/vfr/2026-09-03/3x/{z}/{x}/{y}.jxl";

const release = (over: Record<string, unknown> = {}) => ({
  tiles: CURRENT_TILES,
  minZoom: 0,
  maxZoom: 12,
  effective: "2026-07-09T09:01:00Z",
  ...over,
});

describe("selectChart", () => {
  it("flies the current release when nothing is queued", () => {
    const chart = selectChart({ current: release(), next: null }, EFFECTIVE_MS);
    expect(chart?.tiles).toBe(CURRENT_TILES);
    expect(chart?.minZoom).toBe(0);
    expect(chart?.maxZoom).toBe(12);
  });

  it("holds a baked-but-not-yet-effective cycle back", () => {
    const chart = selectChart(
      {
        current: release(),
        next: release({ tiles: NEXT_TILES, effective: EFFECTIVE }),
      },
      EFFECTIVE_MS - 1,
    );
    expect(chart?.tiles).toBe(CURRENT_TILES);
  });

  it("switches the moment the new cycle takes force", () => {
    const chart = selectChart(
      {
        current: release(),
        next: release({ tiles: NEXT_TILES, effective: EFFECTIVE }),
      },
      EFFECTIVE_MS,
    );
    expect(chart?.tiles).toBe(NEXT_TILES);
  });

  it("never promotes a next that cannot say when it takes force", () => {
    const chart = selectChart(
      {
        current: release(),
        next: release({ tiles: NEXT_TILES, effective: undefined }),
      },
      EFFECTIVE_MS,
    );
    expect(chart?.tiles).toBe(CURRENT_TILES);
  });

  it("keeps flying current when an effective next is unusable", () => {
    const chart = selectChart(
      {
        current: release(),
        next: release({ effective: EFFECTIVE, tiles: "/vfr/no/placeholders" }),
      },
      EFFECTIVE_MS,
    );
    expect(chart?.tiles).toBe(CURRENT_TILES);
  });

  it("shows nothing rather than a premature chart", () => {
    const chart = selectChart(
      { current: null, next: release({ effective: EFFECTIVE }) },
      EFFECTIVE_MS - 1,
    );
    expect(chart).toBeNull();
  });

  it("rejects a release with no zoom range", () => {
    expect(
      selectChart({ current: release({ maxZoom: undefined }) }, EFFECTIVE_MS),
    ).toBeNull();
  });

  it("rejects a template that is not a tile template", () => {
    expect(
      selectChart({ current: release({ tiles: "/vfr/2026-07-09/3x/" }) }, 0),
    ).toBeNull();
  });

  it("resolves a relative template without escaping the placeholders", () => {
    const chart = selectChart(
      { current: release({ tiles: "/vfr/2026-07-09/3x/{z}/{x}/{y}.jxl" }) },
      EFFECTIVE_MS,
    );
    expect(chart?.tiles).toBe(
      "https://charts.wingover.app/vfr/2026-07-09/3x/{z}/{x}/{y}.jxl",
    );
  });

  it("survives a manifest that is not one", () => {
    expect(selectChart(null, 0)).toBeNull();
    expect(selectChart("nope", 0)).toBeNull();
    expect(selectChart({}, 0)).toBeNull();
  });
});

describe("pinnedTemplate", () => {
  const APP = "https://wingover.app";
  const TILES = "/vfr/07-09-2026k/3x/{z}/{x}/{y}.jxl";

  it("takes a bake on the chart host", () => {
    expect(pinnedTemplate(CURRENT_TILES, APP)).toBe(CURRENT_TILES);
  });

  it("takes tiles served by the app itself, relative or absolute", () => {
    expect(pinnedTemplate(TILES, APP)).toBe(`${APP}${TILES}`);
    expect(pinnedTemplate(`${APP}${TILES}`, APP)).toBe(`${APP}${TILES}`);
  });

  it("refuses a foreign host", () => {
    expect(pinnedTemplate(`https://evil.example${TILES}`, APP)).toBeNull();
    // A lookalike is a different origin, and so is the same host on a
    // different scheme or port.
    expect(
      pinnedTemplate(`https://charts.wingover.app.evil.example${TILES}`, APP),
    ).toBeNull();
    expect(
      pinnedTemplate(`http://charts.wingover.app${TILES}`, APP),
    ).toBeNull();
    expect(pinnedTemplate(`https://wingover.app:8443${TILES}`, APP)).toBeNull();
  });

  it("stays off when unset", () => {
    expect(pinnedTemplate(null, APP)).toBeNull();
    expect(pinnedTemplate("", APP)).toBeNull();
  });

  it("keeps the placeholders unescaped", () => {
    expect(pinnedTemplate(TILES, APP)).toContain("{z}/{x}/{y}");
  });
});
