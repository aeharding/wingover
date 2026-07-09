// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { parseGpx } from "./gpxImport";

const PPG_FLYER_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="ppg-flyer-export" xmlns="http://www.topografix.com/GPX/1/1">
<metadata>
<name>2022-07-09 18:29 Tomahawk Regional Airport</name>
<time>2022-07-09T23:29:40.001Z</time>
</metadata>
<rte><name>Planned route</name>
<rtept lat="42.882548857" lon="-89.398851773"/>
</rte>
<trk><name>2022-07-09 18:29 Tomahawk Regional Airport</name>
<desc>duration 02:00:04, distance 68.6 km</desc>
<trkseg>
<trkpt lat="45.468797403" lon="-89.802241635"><ele>454.6</ele><time>2022-07-09T23:29:40.001Z</time></trkpt>
<trkpt lat="45.467903274" lon="-89.802503921"><ele>455.1</ele><time>2022-07-09T23:29:40.045Z</time></trkpt>
<trkpt lat="45.468787289" lon="-89.802251824"><ele>454.6</ele><time>2022-07-09T23:29:41.001Z</time></trkpt>
<trkpt lat="45.468774031" lon="-89.802264706"><ele>455.5</ele><time>2022-07-09T23:29:42.001Z</time></trkpt>
<trkpt lat="45.468761247" lon="-89.802270615"><ele>456.5</ele><time>2022-07-09T23:29:43.001Z</time></trkpt>
<trkpt lat="45.468748959" lon="-89.802277739"><ele>457.5</ele><time>2022-07-09T23:29:44.001Z</time></trkpt>
</trkseg>
</trk>
</gpx>`;

describe("parseGpx", () => {
  it("parses PPG Flyer exports", () => {
    const { name, fixes } = parseGpx(PPG_FLYER_GPX);
    expect(name).toBe("2022-07-09 18:29 Tomahawk Regional Airport");
    expect(fixes).toHaveLength(5);
    expect(fixes[0].timestamp).toBe(Date.parse("2022-07-09T23:29:40.001Z"));
    expect(fixes[0].altitude).toBe(454.6);
  });

  it("drops burst duplicates so derived speeds stay sane", () => {
    const { fixes } = parseGpx(PPG_FLYER_GPX);
    for (const fix of fixes) {
      expect(fix.speed).toBeLessThan(60);
      expect(fix.speed).toBeGreaterThanOrEqual(0);
    }
  });

  it("derives climb rate and course", () => {
    const { fixes } = parseGpx(PPG_FLYER_GPX);
    expect(fixes[3].climbRate).toBeCloseTo(1, 1);
    for (const fix of fixes) {
      expect(fix.course).toBeGreaterThanOrEqual(0);
      expect(fix.course).toBeLessThan(360);
    }
  });

  it("ignores route points and rejects unusable files", () => {
    expect(() => parseGpx("<gpx></gpx>")).toThrow();
    expect(() =>
      parseGpx(
        `<gpx><trk><trkseg><trkpt lat="1" lon="2"><time>2022-01-01T00:00:00Z</time></trkpt></trkseg></trk></gpx>`,
      ),
    ).toThrow();
  });
});
