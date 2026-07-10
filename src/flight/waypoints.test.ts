import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createWaypointTracker, type Waypoint } from "./waypoints";

interface GoldenCase {
  name: string;
  waypoints: Waypoint[];
  fixes: { timestamp: number; latitude: number; longitude: number }[];
  announcements: { atTimestamp: number; text: string }[];
}

const golden = JSON.parse(
  readFileSync(join(__dirname, "golden.json"), "utf8"),
) as { cases: GoldenCase[] };

describe("waypoint tracker golden vectors (shared with cargo suite)", () => {
  for (const goldenCase of golden.cases) {
    it(goldenCase.name, () => {
      const tracker = createWaypointTracker();
      tracker.setWaypoints(goldenCase.waypoints);
      const produced: { atTimestamp: number; text: string }[] = [];
      for (const fix of goldenCase.fixes) {
        for (const text of tracker.ingest(fix)) {
          produced.push({ atTimestamp: fix.timestamp, text });
        }
      }
      expect(produced).toEqual(goldenCase.announcements);
    });
  }
});

describe("waypoint tracker set semantics", () => {
  it("unchanged waypoints keep arm state across set", () => {
    const waypoint: Waypoint = {
      id: "a",
      latitude: 43.0,
      longitude: -89.4,
      radiusM: 200,
    };
    const inside = { latitude: 43.0, longitude: -89.4 };
    const tracker = createWaypointTracker();
    tracker.setWaypoints([waypoint]);
    expect(tracker.ingest(inside)).toEqual([]); // armed inside, silent
    tracker.setWaypoints([{ ...waypoint }]); // unchanged definition
    expect(tracker.ingest(inside)).toEqual([]);
  });
});
