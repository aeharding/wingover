import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Pin } from "../storage/db";
import type { Fix } from "./types";

// session.ts is the ONE projection of plan pins -> session waypoints
// (ARCHITECTURE.md's flight-scoped-config seam) and the home of flight
// collection. Mock the three edges it touches — the pin store, the settings
// store, and the engine — and assert the projection, the copy-at-start
// behavior it documents, and that a finalized flight is collected with no
// view mounted at all.
const dbMock = vi.hoisted(() => ({
  listPins: vi.fn(),
  saveFlight: vi.fn(),
  inheritedLaunchName: vi.fn(),
}));
const localMock = vi.hoisted(() => ({ getDetectLanding: vi.fn() }));

// A driveable engine, not a bag of spies: collection is wired to the change
// signal, so the test has to be able to fire one. getSnapshot always resolves
// — importing session.ts kicks the one-time WAL hydration through it.
const engineMock = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = { status: "idle", track: [] as unknown[], waypoints: [] };
  const engine = {
    start: vi.fn(),
    retry: vi.fn(),
    getSnapshot: vi.fn(() => Promise.resolve({ ...state })),
    snapshotSync: vi.fn(() => ({ ...state })),
    discard: vi.fn(() => {
      state.status = "idle";
      return Promise.resolve();
    }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    engine,
    state,
    notify: () => {
      for (const listener of [...listeners]) listener();
    },
    reset: () => {
      listeners.clear();
      state.status = "idle";
      state.track = [];
      state.waypoints = [];
    },
  };
});

vi.mock("../storage/db", () => dbMock);
vi.mock("../storage/local", () => localMock);
vi.mock("./index", () => engineMock);

// WAYPOINT_RADIUS_M stays the REAL constant (not mocked) so the test pins the
// actual geofence radius the projection stamps.
import { WAYPOINT_RADIUS_M } from "../flight/waypoints";
import { startFlight } from "./session";

function pin(over: Partial<Pin> = {}): Pin {
  return {
    id: "p1",
    name: "Launch",
    notes: "grassy knoll",
    latitude: 46,
    longitude: 7,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

const startArg = () =>
  engineMock.engine.start.mock.calls[0]?.[0] as {
    waypoints: unknown[];
    detectLanding: boolean;
  };

describe("startFlight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localMock.getDetectLanding.mockResolvedValue(true);
    engineMock.engine.start.mockResolvedValue(undefined);
  });

  it("copies the plan pins into the session as ordered geofence waypoints", async () => {
    dbMock.listPins.mockResolvedValue([
      pin({ id: "a", latitude: 46.1, longitude: 7.1 }),
      pin({ id: "b", latitude: 46.2, longitude: 7.2 }),
    ]);

    await startFlight();

    expect(engineMock.engine.start).toHaveBeenCalledOnce();
    expect(startArg().waypoints).toEqual([
      { id: "a", latitude: 46.1, longitude: 7.1, radiusM: WAYPOINT_RADIUS_M },
      { id: "b", latitude: 46.2, longitude: 7.2, radiusM: WAYPOINT_RADIUS_M },
    ]);
  });

  it("never leaks pin planning fields (name, notes) into the waypoint", async () => {
    dbMock.listPins.mockResolvedValue([
      pin({ name: "Secret LZ", notes: "power lines to the east" }),
    ]);

    await startFlight();

    const wp = startArg().waypoints[0] as Record<string, unknown>;
    expect(Object.keys(wp).sort()).toEqual([
      "id",
      "latitude",
      "longitude",
      "radiusM",
    ]);
    expect(wp).not.toHaveProperty("name");
    expect(wp).not.toHaveProperty("notes");
  });

  it("starts with an empty waypoint set when there is no plan", async () => {
    dbMock.listPins.mockResolvedValue([]);

    await startFlight();

    expect(startArg().waypoints).toEqual([]);
  });

  it("copies the detect-landing setting the flight takes off with (default on)", async () => {
    dbMock.listPins.mockResolvedValue([]);
    localMock.getDetectLanding.mockResolvedValue(false);

    await startFlight();

    expect(startArg().detectLanding).toBe(false);
  });
});

function fix(timestamp: number): Fix {
  return {
    timestamp,
    latitude: 46,
    longitude: 7,
    altitude: 500,
    speed: 10,
    course: 90,
    climbRate: 0,
    horizontalAccuracy: 5,
    verticalAccuracy: 5,
  };
}

const FLOWN = [fix(1000), fix(2000), fix(3000)];

/**
 * Collection lives here and not in the flight surface because a view can be
 * unmounted while the flight is still the engine's to hand over — which is
 * exactly what the in-flight error boundary does when a crash cannot heal.
 * discard() is the only transition to "idle", so a collection that does not
 * run pins the app on "ended": the flight never reaches the logbook, sync
 * stays paused, and the shell never comes back (e2e/crash-boundary.spec.ts
 * drills the pilot-visible half).
 *
 * Every test here runs with NO view mounted at all — that is the point.
 */
describe("collection", () => {
  let consoleError: { mockRestore(): void };

  function bootSession() {
    vi.resetModules();
    return import("./session");
  }

  function endedWith(track: Fix[]) {
    engineMock.state.status = "ended";
    engineMock.state.track = track;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    engineMock.reset();
    dbMock.saveFlight.mockResolvedValue(undefined);
    dbMock.inheritedLaunchName.mockResolvedValue("Home Field");
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
    delete (globalThis as { document?: unknown }).document;
  });

  it("collects a flight that ended while the app was away, at boot", async () => {
    endedWith(FLOWN);

    await bootSession();

    await vi.waitFor(() =>
      expect(engineMock.engine.discard).toHaveBeenCalledOnce(),
    );
    expect(dbMock.saveFlight).toHaveBeenCalledOnce();
    const [flight, fixes] = dbMock.saveFlight.mock.calls[0];
    // Deterministic id (first fix): collecting twice must not duplicate.
    expect(flight.id).toBe("recorded-1000");
    expect(flight.launchAt).toEqual([7, 46]);
    expect(flight.launchName).toBe("Home Field");
    expect(fixes).toBe(FLOWN);
  });

  it("collects a flight that ends live, off the engine's change signal", async () => {
    await bootSession();
    expect(dbMock.saveFlight).not.toHaveBeenCalled();

    endedWith(FLOWN);
    engineMock.notify();

    await vi.waitFor(() =>
      expect(engineMock.engine.discard).toHaveBeenCalledOnce(),
    );
    expect(dbMock.saveFlight).toHaveBeenCalledOnce();
  });

  // Left for the shell that mounts next, which is what the discard below
  // brings back. An id, not the record: the logbook owns what a flight IS,
  // and a landing summary would route there anyway.
  it("leaves the ended flight's id for the shell, once", async () => {
    const { consumeEndedFlight } = await bootSession();

    endedWith(FLOWN);
    engineMock.notify();

    await vi.waitFor(() =>
      expect(engineMock.engine.discard).toHaveBeenCalledOnce(),
    );
    expect(consumeEndedFlight()).toBe("recorded-1000");
    // Taken, not read: a second consumer must not show the same flight again.
    expect(consumeEndedFlight()).toBeNull();
  });

  it("keeps the engine's copy when the save fails, and says so", async () => {
    dbMock.saveFlight.mockRejectedValue(new Error("disk full"));
    const { consumeEndedFlight, collectionFailedSync } = await bootSession();

    endedWith(FLOWN);
    engineMock.notify();

    await vi.waitFor(() => expect(dbMock.saveFlight).toHaveBeenCalled());
    // The WAL is the only copy of this flight; nothing may drop it.
    expect(engineMock.engine.discard).not.toHaveBeenCalled();
    // Nothing to ANNOUNCE — a flight that did not reach the logbook is not a
    // saved one — but the pilot is not left guessing either: this flag is what
    // gives the "ended" surface something to say (SavingSurface). Asserted
    // because the failure is silent without it, and silence on this ring is
    // what STEERING forbids.
    expect(consumeEndedFlight()).toBeNull();
    expect(collectionFailedSync()).toBe(true);
  });

  it("clears the failure once a retry gets the flight through", async () => {
    dbMock.saveFlight.mockRejectedValueOnce(new Error("disk full"));
    const { collectionFailedSync, retryCollection } = await bootSession();

    endedWith(FLOWN);
    engineMock.notify();
    await vi.waitFor(() => expect(collectionFailedSync()).toBe(true));

    retryCollection();

    await vi.waitFor(() =>
      expect(engineMock.engine.discard).toHaveBeenCalledOnce(),
    );
    expect(collectionFailedSync()).toBe(false);
  });

  it("retries a failed save on the next foreground", async () => {
    const handlers = new Map<string, () => void>();
    (globalThis as { document?: unknown }).document = {
      visibilityState: "visible",
      addEventListener: (type: string, handler: () => void) =>
        handlers.set(type, handler),
    };
    dbMock.saveFlight.mockRejectedValueOnce(new Error("disk full"));
    await bootSession();
    endedWith(FLOWN);
    engineMock.notify();
    await vi.waitFor(() => expect(dbMock.saveFlight).toHaveBeenCalledOnce());

    handlers.get("visibilitychange")!();

    await vi.waitFor(() =>
      expect(engineMock.engine.discard).toHaveBeenCalledOnce(),
    );
    expect(dbMock.saveFlight).toHaveBeenCalledTimes(2);
  });

  it("a flight already in the logbook (conflict) is collected, not re-thrown", async () => {
    dbMock.saveFlight.mockRejectedValue(
      Object.assign(new Error("Document update conflict"), {
        name: "conflict",
      }),
    );
    const { consumeEndedFlight } = await bootSession();

    endedWith(FLOWN);
    engineMock.notify();

    await vi.waitFor(() =>
      expect(engineMock.engine.discard).toHaveBeenCalledOnce(),
    );
    expect(consumeEndedFlight()).toBe("recorded-1000");
  });

  it("runs one collection at a time, however many signals arrive", async () => {
    let release = () => {};
    dbMock.saveFlight.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await bootSession();

    endedWith(FLOWN);
    engineMock.notify();
    engineMock.notify();
    engineMock.notify();
    await vi.waitFor(() => expect(dbMock.saveFlight).toHaveBeenCalledOnce());

    release();
    await vi.waitFor(() =>
      expect(engineMock.engine.discard).toHaveBeenCalledOnce(),
    );
    expect(dbMock.saveFlight).toHaveBeenCalledOnce();
  });

  it("releases the engine's copy even when there was no flight to save", async () => {
    // A session that ended without a real track still has to reach "idle",
    // or the app pins on "ended" exactly as the deadlock did. Silently: there
    // is no flight to tell the pilot about.
    const { consumeEndedFlight } = await bootSession();

    endedWith([fix(1000)]);
    engineMock.notify();

    await vi.waitFor(() =>
      expect(engineMock.engine.discard).toHaveBeenCalledOnce(),
    );
    expect(dbMock.saveFlight).not.toHaveBeenCalled();
    expect(consumeEndedFlight()).toBeNull();
  });

  it("leaves a live flight alone", async () => {
    engineMock.state.status = "recording";
    engineMock.state.track = FLOWN;

    await bootSession();
    engineMock.notify();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(dbMock.saveFlight).not.toHaveBeenCalled();
    expect(engineMock.engine.discard).not.toHaveBeenCalled();
  });
});
