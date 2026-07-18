import { describe, expect, it } from "vitest";

import { FlightSimulator } from "../engine/simulator";
import { flightToGpx } from "./gpx";

describe("flightToGpx", () => {
  it("serializes a flight with one trkpt per fix", () => {
    const fixes = new FlightSimulator(42, 1700000000000).fixesUpTo(120);
    const gpx = flightToGpx(
      { name: "Morning sled ride", startedAt: fixes[0].timestamp },
      fixes,
    );

    expect(gpx).toContain('<gpx version="1.1" creator="Wingover"');
    expect(gpx).toContain("<name>Morning sled ride</name>");
    expect(gpx.match(/<trkpt /g)).toHaveLength(120);
    expect(gpx).toContain("<time>2023-11-14T22:13:20.000Z</time>");
  });

  it("escapes XML in flight names", () => {
    const fixes = new FlightSimulator(1, 0).fixesUpTo(2);
    const gpx = flightToGpx(
      { name: 'Lake <Pleasant> & "friends"', startedAt: 0 },
      fixes,
    );

    expect(gpx).toContain(
      "<name>Lake &lt;Pleasant&gt; &amp; &quot;friends&quot;</name>",
    );
  });

  it("titles an unnamed flight by launch site, then date", () => {
    const fixes = new FlightSimulator(3, 1700000000000).fixesUpTo(2);
    expect(
      flightToGpx(
        { name: "", launchName: "Madcity", startedAt: fixes[0].timestamp },
        fixes,
      ),
    ).toContain("<name>Madcity</name>");
    expect(
      flightToGpx({ name: "", startedAt: fixes[0].timestamp }, fixes),
    ).toMatch(/<name>[^<]*2023[^<]*<\/name>/);
  });
});
