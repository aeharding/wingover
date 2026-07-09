import { describe, expect, it } from "vitest";

import { FlightSimulator } from "../engine/simulator";
import { computeStats } from "../flight/stats";
import {
  deleteFlight,
  deletePin,
  type Flight,
  getFlight,
  getSetting,
  getTrack,
  listFlights,
  listPins,
  saveFlight,
  savePin,
  setSetting,
  updateFlight,
  updatePin,
} from "./db";

function makeFlight(fixes: ReturnType<FlightSimulator["fixesUpTo"]>): Flight {
  return {
    id: crypto.randomUUID(),
    name: "Test flight",
    notes: "",
    startedAt: fixes[0].timestamp,
    stats: computeStats(fixes),
    updatedAt: Date.now(),
  };
}

describe("storage", () => {
  it("round-trips a flight and its gzipped track attachment", async () => {
    const fixes = new FlightSimulator(42, 0).fixesUpTo(120);
    const flight = makeFlight(fixes);
    await saveFlight(flight, fixes);

    const listed = await listFlights();
    expect(listed.map((f) => f.id)).toContain(flight.id);

    const track = await getTrack(flight.id);
    expect(track).toHaveLength(120);
    expect(track[0]).toEqual(fixes[0]);
  });

  it("lists flights newest first", async () => {
    const older = makeFlight(new FlightSimulator(1, 1000).fixesUpTo(30));
    const newer = makeFlight(new FlightSimulator(2, 999999000).fixesUpTo(30));
    await saveFlight(older, []);
    await saveFlight(newer, []);

    const listed = await listFlights();
    const olderIndex = listed.findIndex((f) => f.id === older.id);
    const newerIndex = listed.findIndex((f) => f.id === newer.id);
    expect(newerIndex).toBeLessThan(olderIndex);
  });

  it("updates metadata without touching the track", async () => {
    const fixes = new FlightSimulator(7, 0).fixesUpTo(60);
    const flight = makeFlight(fixes);
    await saveFlight(flight, fixes);

    await updateFlight(flight.id, { name: "Renamed", notes: "Great air" });

    const stored = await getFlight(flight.id);
    expect(stored?.name).toBe("Renamed");
    expect(stored?.notes).toBe("Great air");
    expect(stored?.updatedAt).toBeGreaterThanOrEqual(flight.updatedAt);
    expect(await getTrack(flight.id)).toHaveLength(60);
  });

  it("deletes a flight and its track", async () => {
    const fixes = new FlightSimulator(9, 0).fixesUpTo(60);
    const flight = makeFlight(fixes);
    await saveFlight(flight, fixes);

    await deleteFlight(flight.id);

    expect((await listFlights()).map((f) => f.id)).not.toContain(flight.id);
    expect(await getFlight(flight.id)).toBeNull();
    expect(await getTrack(flight.id)).toHaveLength(0);
  });

  it("round-trips, updates, and deletes pins", async () => {
    const now = Date.now();
    const pin = {
      id: crypto.randomUUID(),
      name: "LZ Alpha",
      notes: "",
      latitude: 33.9,
      longitude: -112.2,
      createdAt: now,
      updatedAt: now,
    };
    await savePin(pin);
    expect((await listPins()).map((p) => p.id)).toContain(pin.id);

    await updatePin(pin.id, { notes: "Gate code 4242" });
    const listed = (await listPins()).find((p) => p.id === pin.id);
    expect(listed?.notes).toBe("Gate code 4242");

    await deletePin(pin.id);
    expect((await listPins()).map((p) => p.id)).not.toContain(pin.id);
  });

  it("round-trips settings", async () => {
    expect(await getSetting("units")).toBeNull();
    await setSetting("units", "metric");
    expect(await getSetting("units")).toBe("metric");
    await setSetting("units", "imperial");
    expect(await getSetting("units")).toBe("imperial");
  });
});
