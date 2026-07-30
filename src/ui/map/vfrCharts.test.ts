// Set before the module under test runs any date math: Hawaii is far
// enough west that 0901Z is the previous evening, which is the whole
// reason chartLabel formats in UTC.
process.env.TZ = "Pacific/Honolulu";

import { describe, expect, it } from "vitest";

import { chartLabel, selectChart } from "./vfrCharts";

const EFFECTIVE = "2026-09-03T09:01:00Z";
const EFFECTIVE_MS = Date.parse(EFFECTIVE);

const release = (over: Record<string, unknown> = {}) => ({
  cycle: "2026-07-09",
  tiles: "https://charts.wingover.app/vfr/2026-07-09/3x/{z}/{x}/{y}.jxl",
  minZoom: 0,
  maxZoom: 12,
  effective: "2026-07-09T09:01:00Z",
  ...over,
});

describe("selectChart", () => {
  it("flies the current release when nothing is queued", () => {
    const chart = selectChart({ current: release(), next: null }, EFFECTIVE_MS);
    expect(chart?.cycle).toBe("2026-07-09");
    expect(chart?.minZoom).toBe(0);
    expect(chart?.maxZoom).toBe(12);
  });

  it("holds a baked-but-not-yet-effective cycle back", () => {
    const chart = selectChart(
      {
        current: release(),
        next: release({ cycle: "2026-09-03", effective: EFFECTIVE }),
      },
      EFFECTIVE_MS - 1,
    );
    expect(chart?.cycle).toBe("2026-07-09");
  });

  it("switches the moment the new cycle takes force", () => {
    const chart = selectChart(
      {
        current: release(),
        next: release({ cycle: "2026-09-03", effective: EFFECTIVE }),
      },
      EFFECTIVE_MS,
    );
    expect(chart?.cycle).toBe("2026-09-03");
  });

  it("never promotes a next that cannot say when it takes force", () => {
    const chart = selectChart(
      {
        current: release(),
        next: release({ cycle: "2026-09-03", effective: undefined }),
      },
      EFFECTIVE_MS,
    );
    expect(chart?.cycle).toBe("2026-07-09");
  });

  it("keeps flying current when an effective next is unusable", () => {
    const chart = selectChart(
      {
        current: release(),
        next: release({ effective: EFFECTIVE, tiles: "/vfr/no/placeholders" }),
      },
      EFFECTIVE_MS,
    );
    expect(chart?.cycle).toBe("2026-07-09");
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

describe("chartLabel", () => {
  it("names the edition by its UTC date, west of the dateline included", () => {
    const chart = selectChart(
      { current: release({ effective: "2026-07-09T09:01:00Z" }) },
      0,
    );
    // Local time in Honolulu is the 8th at 2301; the chart is the 9th.
    // Asserted on the day alone, since the label's shape follows the
    // runner's locale and only the day can differ between the readings.
    const label = chartLabel(chart!);
    expect(label).toMatch(/\b9\b/);
    expect(label).not.toMatch(/\b8\b/);
  });

  it("falls back to the cycle the manifest states, then to nothing", () => {
    const noEffective = selectChart(
      { current: release({ effective: undefined, cycle: "07-09-2026" }) },
      0,
    );
    expect(chartLabel(noEffective!)).toBe("07-09-2026");
    const anonymous = selectChart(
      { current: release({ effective: undefined, cycle: undefined }) },
      0,
    );
    expect(chartLabel(anonymous!)).toBeNull();
  });
});
