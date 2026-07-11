import { describe, expect, it } from "vitest";

import { WebCore, withWebCore } from "./core";
import type { PositionSource } from "./real";

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

describe("withWebCore wake lock", () => {
  // A hidden PWA tab loses its geolocation watch with no backlog to
  // replay: fixes while the screen sleeps are lost for good. The watch
  // holds a screen wake lock and re-acquires it whenever the page becomes
  // visible again (browsers release it on hide).
  it("acquires with the watch, re-acquires on visibility, releases on teardown", async () => {
    const requests: string[] = [];
    let releases = 0;
    const visibilityListeners = new Set<() => void>();
    Object.defineProperty(globalThis, "navigator", {
      value: {
        wakeLock: {
          request: async (type: string) => {
            requests.push(type);
            return { release: async () => void releases++ };
          },
        },
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "document", {
      value: {
        visibilityState: "visible",
        addEventListener: (type: string, listener: () => void) => {
          if (type === "visibilitychange") visibilityListeners.add(listener);
        },
        removeEventListener: (type: string, listener: () => void) => {
          if (type === "visibilitychange") visibilityListeners.delete(listener);
        },
      },
      configurable: true,
      writable: true,
    });

    const inner: PositionSource = { watch: () => () => {} };
    const unwatch = withWebCore(inner).source.watch(
      () => {},
      () => {},
    );
    await Promise.resolve();
    expect(requests).toEqual(["screen"]);

    // Page hidden and back (browser dropped the sentinel): re-acquire.
    for (const listener of visibilityListeners) listener();
    await Promise.resolve();
    expect(requests).toEqual(["screen", "screen"]);

    unwatch();
    await Promise.resolve();
    expect(releases).toBeGreaterThan(0);
    expect(visibilityListeners.size).toBe(0);
  });
});
