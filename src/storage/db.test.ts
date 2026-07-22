import { describe, expect, it } from "vitest";

import { FlightSimulator } from "../engine/simulator";
import { computeStats } from "../flight/stats";
import {
  deleteAllPins,
  deleteFlight,
  deletePin,
  type Flight,
  getFlight,
  getTrack,
  inheritedLaunchName,
  listFlights,
  listPins,
  saveFlight,
  savePin,
  stripMintedFlightNames,
  syncedDb,
  updateFlight,
  updatePin,
} from "./db";
import { getSetting, setSetting } from "./local";

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

  it("round-trips a flight's planned route, omitting it when absent", async () => {
    const fixes = new FlightSimulator(11, 0).fixesUpTo(60);
    const withPlan: Flight = {
      ...makeFlight(fixes),
      plannedRoute: [
        [-112.2, 33.9],
        [-112.1, 33.95],
      ],
    };
    await saveFlight(withPlan, fixes);
    expect((await getFlight(withPlan.id))?.plannedRoute).toEqual([
      [-112.2, 33.9],
      [-112.1, 33.95],
    ]);

    // A flight recorded without a plan reads back with no route (not []).
    const noPlan = makeFlight(new FlightSimulator(12, 0).fixesUpTo(60));
    await saveFlight(noPlan, fixes);
    expect((await getFlight(noPlan.id))?.plannedRoute).toBeUndefined();
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
    const trackBefore = await syncedDb().get(`track:${flight.id}`);

    await updateFlight(flight.id, { name: "Renamed", notes: "Great air" });

    const stored = await getFlight(flight.id);
    expect(stored?.name).toBe("Renamed");
    expect(stored?.notes).toBe("Great air");
    expect(stored?.updatedAt).toBeGreaterThanOrEqual(flight.updatedAt);
    expect(await getTrack(flight.id)).toHaveLength(60);

    // The track is a SEPARATE document precisely so this holds: PouchDB
    // re-sends a doc's attachments on every revision of that doc when pushing,
    // so a rename with the track attached re-uploaded the whole track (~275KB
    // for two hours). Readable-after-rename doesn't prove that; these two do.
    // The flight doc carrying NO attachment is the load-bearing one — watching
    // only the track doc's _rev would miss the track being re-attached here,
    // which is exactly how this regresses.
    const renamed = await syncedDb().get<{ _attachments?: unknown }>(
      `flight:${flight.id}`,
      { attachments: false },
    );
    expect(renamed._attachments).toBeUndefined();
    expect((await syncedDb().get(`track:${flight.id}`))._rev).toBe(
      trackBefore._rev,
    );
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

  it("inherits the launch name from the nearest previous named launch", async () => {
    // Two named launches at the same field; the newer name must win, so a
    // pilot's correction propagates forward without rewriting history.
    const older: Flight = {
      ...makeFlight(new FlightSimulator(31, 1000).fixesUpTo(30)),
      launchAt: [-112.2, 33.9],
      launchName: "Miller's Field",
    };
    const newer: Flight = {
      ...makeFlight(new FlightSimulator(32, 2_000_000_000).fixesUpTo(30)),
      launchAt: [-112.2001, 33.9002],
      launchName: "North Forty",
    };
    await saveFlight(older, []);
    await saveFlight(newer, []);

    // ~150m away: same field.
    expect(await inheritedLaunchName([-112.1984, 33.9])).toBe("North Forty");
    // ~5km away: a different place entirely.
    expect(await inheritedLaunchName([-112.2, 33.95])).toBeUndefined();
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

  it("deleteAllPins clears the whole route and no-ops when empty", async () => {
    await deleteAllPins();
    expect(await listPins()).toHaveLength(0);
    // No-op on an already-empty route (must not throw).
    await deleteAllPins();

    const now = Date.now();
    for (let i = 0; i < 4; i++) {
      await savePin({
        id: crypto.randomUUID(),
        name: `Pin ${i}`,
        notes: "",
        latitude: 33 + i,
        longitude: -112,
        createdAt: now + i,
        updatedAt: now + i,
      });
    }
    expect(await listPins()).toHaveLength(4);

    await deleteAllPins();
    expect(await listPins()).toHaveLength(0);
  });

  it("round-trips settings", async () => {
    expect(await getSetting("units")).toBeNull();
    await setSetting("units", "metric");
    expect(await getSetting("units")).toBe("metric");
    await setSetting("units", "imperial");
    expect(await getSetting("units")).toBe("imperial");
  });

  it("keystroke-burst setSetting writes land in order, newest last", async () => {
    // Un-awaited per-keystroke saves used to race: an equality check against
    // a stale in-flight read could silently drop the newest value ("abc123"
    // typed, "abc12" stored), and bursts exhausted the conflict retries.
    const burst = ["abc12", "abc123", "abc1", "abc", "abc123x"];
    await Promise.all(burst.map((v) => setSetting("maptilerKey", v)));
    expect(await getSetting("maptilerKey")).toBe("abc123x");

    // The backspace-then-retype shape from the review, explicitly.
    await setSetting("maptilerKey", "abc123");
    const a = setSetting("maptilerKey", "abc12");
    const b = setSetting("maptilerKey", "abc123");
    await Promise.all([a, b]);
    expect(await getSetting("maptilerKey")).toBe("abc123");
  });
});
describe("stripMintedFlightNames", () => {
  it("strips exactly the minted default name, never a pilot's", async () => {
    const fixes = new FlightSimulator(7, 0).fixesUpTo(60);
    const minted: Flight = {
      ...makeFlight(fixes),
      name: `Flight ${new Date(fixes[0].timestamp).toLocaleString()}`,
    };
    const custom: Flight = { ...makeFlight(fixes), name: "Sunset ridge" };
    await saveFlight(minted, fixes);
    await saveFlight(custom, fixes);

    await stripMintedFlightNames();

    expect((await getFlight(minted.id))?.name).toBe("");
    expect((await getFlight(custom.id))?.name).toBe("Sunset ridge");
    // Idempotent: a second pass changes nothing.
    await stripMintedFlightNames();
    expect((await getFlight(minted.id))?.name).toBe("");
  });
});
