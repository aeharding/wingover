import { describe, expect, it } from "vitest";

import { isLanded } from "./landing";
import { FlightSimulator, SIM_FLIGHT_END_S } from "./simulator";
import { computeStats, haversineMeters } from "./stats";
import { detectTakeoff } from "./takeoff";

describe("FlightSimulator", () => {
  it("is deterministic for a given seed", () => {
    const a = new FlightSimulator(42, 0).fixesUpTo(600);
    const b = new FlightSimulator(42, 0).fixesUpTo(600);
    expect(a).toEqual(b);
  });

  it("extends incrementally without changing earlier fixes", () => {
    const simulator = new FlightSimulator(7, 0);
    const first = structuredClone(simulator.fixesUpTo(100));
    const longer = simulator.fixesUpTo(200);
    expect(longer.slice(0, 100)).toEqual(first);
    expect(longer).toHaveLength(200);
  });

  it("produces different flights for different seeds", () => {
    const a = new FlightSimulator(1, 0).fixesUpTo(60);
    const b = new FlightSimulator(2, 0).fixesUpTo(60);
    expect(a).not.toEqual(b);
  });

  // The sim's landing is the engine's to detect (record.spec's hands-free
  // two-hour flight), and detection now insists on stopping at the launch
  // point at launch elevation — so the sim must genuinely fly home and
  // descend, whatever the seed wandered. Swept, not sampled: production
  // seeds are Date.now() % 100000, and e2e runs with zero retries.
  it("ends on the ground at the launch point, where detection can see it", () => {
    for (let seed = 0; seed < 50; seed++) {
      const track = new FlightSimulator(seed, 0).fixesUpTo(
        SIM_FLIGHT_END_S + 20,
      );
      const takeoff = detectTakeoff(track);
      expect(takeoff).not.toBeNull();
      expect(isLanded(track, track[takeoff!])).toBe(true);
    }
  });
});

describe("haversineMeters", () => {
  it("measures a known distance", () => {
    const phoenix = { latitude: 33.4484, longitude: -112.074 };
    const tucson = { latitude: 32.2226, longitude: -110.9747 };
    const distance = haversineMeters(phoenix, tucson);
    expect(distance).toBeGreaterThan(170000);
    expect(distance).toBeLessThan(180000);
  });
});

describe("computeStats", () => {
  it("summarizes a simulated 30 minute flight", () => {
    const track = new FlightSimulator(42, 0).fixesUpTo(1800);
    const stats = computeStats(track);
    expect(stats.durationSeconds).toBe(1799);
    expect(stats.distanceMeters).toBeGreaterThan(10000);
    expect(stats.distanceMeters).toBeLessThan(25000);
    expect(stats.maxAltitude).toBeGreaterThan(stats.minAltitude);
    expect(stats.maxAltitude).toBeGreaterThanOrEqual(590);
    expect(stats.launchAltitude).toBe(300);
    expect(stats.maxSpeed).toBeGreaterThanOrEqual(stats.averageSpeed);
    expect(stats.maxClimbRate).toBeGreaterThan(0);
  });

  it("handles an empty track", () => {
    const stats = computeStats([]);
    expect(stats.durationSeconds).toBe(0);
    expect(stats.distanceMeters).toBe(0);
  });

  it("handles a single fix", () => {
    const track = new FlightSimulator(3, 5000).fixesUpTo(1);
    const stats = computeStats(track);
    expect(stats.durationSeconds).toBe(0);
    expect(stats.distanceMeters).toBe(0);
    expect(stats.maxAltitude).toBe(stats.minAltitude);
  });
});
