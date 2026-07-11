import { describe, expect, it } from "vitest";

import { WebCore } from "./core";

// TS twins of the cargo tests in core.rs — same scenarios, same semantics.
const waypoint = { id: "a", latitude: 43, longitude: -89.4, radiusM: 200 };
const outside = { latitude: 42.995, longitude: -89.4 };
const inside = { latitude: 43, longitude: -89.4 };

describe("web core (core.rs twin)", () => {
  it("ingest announces on outside->inside", () => {
    const core = new WebCore();
    core.start();
    core.setWaypoints([waypoint]);
    expect(core.ingest([outside])).toEqual([]);
    expect(core.ingest([inside])).toEqual(["Waypoint reached"]);
  });

  it("ingest announces across a batch", () => {
    const core = new WebCore();
    core.start();
    core.setWaypoints([waypoint]);
    // One replayed batch: arm outside, enter, exit (re-arm), enter again.
    // Evaluation is per fix WITHIN the batch — two announcements, in order.
    expect(core.ingest([outside, inside, outside, inside])).toEqual([
      "Waypoint reached",
      "Waypoint reached",
    ]);
  });

  it("stop clears the waypoints", () => {
    const core = new WebCore();
    core.start();
    core.setWaypoints([waypoint]);
    core.stop();
    core.start();
    expect(core.ingest([outside])).toEqual([]);
    expect(core.ingest([inside])).toEqual([]);
  });

  it("detection resets between sessions", () => {
    const core = new WebCore();
    core.start();
    core.setWaypoints([waypoint]);
    core.ingest([outside]);
    expect(core.ingest([inside])).toEqual(["Waypoint reached"]);
    // Exit, then end the flight with the waypoint armed-outside.
    core.ingest([outside]);
    core.stop();
    // Next flight: a first fix inside must arm silently, not announce.
    core.start();
    core.setWaypoints([waypoint]);
    expect(core.ingest([inside])).toEqual([]);
  });

  it("mid-flight setWaypoints keeps arm state for unchanged waypoints", () => {
    const core = new WebCore();
    core.start();
    core.setWaypoints([waypoint]);
    core.ingest([inside]);
    core.setWaypoints([
      waypoint,
      { id: "b", latitude: 44, longitude: -89.4, radiusM: 200 },
    ]);
    expect(core.ingest([inside])).toEqual([]);
  });
});
