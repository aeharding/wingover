import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LANDING_SUSTAIN_FIXES } from "../flight/landing";
import { GeolocationRecordingEngine, navigatorPositionSource } from "./real";
import type { EngineStatus } from "./types";

class FakeGeolocation {
  private watchers = new Map<
    number,
    { success: PositionCallback; error?: PositionErrorCallback }
  >();
  private nextId = 1;

  watchPosition(
    success: PositionCallback,
    error?: PositionErrorCallback,
  ): number {
    const id = this.nextId++;
    this.watchers.set(id, { success, error });
    return id;
  }

  clearWatch(id: number) {
    this.watchers.delete(id);
  }

  emit(position: GeolocationPosition) {
    for (const watcher of [...this.watchers.values()]) {
      watcher.success(position);
    }
  }

  emitError(code: number) {
    const error = {
      code,
      message: "fake",
      PERMISSION_DENIED: 1,
      POSITION_UNAVAILABLE: 2,
      TIMEOUT: 3,
    } as GeolocationPositionError;
    for (const watcher of [...this.watchers.values()]) {
      watcher.error?.(error);
    }
  }

  get watcherCount() {
    return this.watchers.size;
  }
}

let geolocation: FakeGeolocation;
let timestamp: number;
const engines: GeolocationRecordingEngine[] = [];

function createEngine(): GeolocationRecordingEngine {
  const engine = new GeolocationRecordingEngine();
  engines.push(engine);
  return engine;
}

interface CoordOverrides {
  latitude?: number;
  longitude?: number;
  altitude?: number | null;
  accuracy?: number;
  altitudeAccuracy?: number | null;
  heading?: number | null;
  speed?: number | null;
}

function position(
  overrides: CoordOverrides = {},
  stepMs = 1000,
): GeolocationPosition {
  timestamp += stepMs;
  return {
    timestamp,
    coords: {
      latitude: 43.0,
      longitude: -89.4,
      altitude: 300,
      accuracy: 5,
      altitudeAccuracy: 8,
      heading: 90,
      speed: 0,
      ...overrides,
    },
  } as GeolocationPosition;
}

beforeEach(async () => {
  geolocation = new FakeGeolocation();
  Object.defineProperty(globalThis, "navigator", {
    value: { geolocation },
    configurable: true,
    writable: true,
  });
  timestamp = 1_700_000_000_000;
  // Fresh IndexedDB per test: engines from earlier tests have
  // fire-and-forget WAL writes that would otherwise land after clearWal
  // and pollute this test's rehydration reads.
  globalThis.indexedDB = new IDBFactory();
});

// Drain: stop() awaits each engine's WAL queue, so no test leaves
// fire-and-forget writes to land in the next test's database.
afterEach(async () => {
  for (const engine of engines) await engine.stop();
  engines.length = 0;
});

async function armAndTakeOff(engine: GeolocationRecordingEngine) {
  await engine.start();
  for (let i = 0; i < 3; i++) geolocation.emit(position({ speed: 0 }));
  geolocation.emit(position({ speed: 2 }));
  geolocation.emit(position({ speed: 3 }));
  for (let i = 0; i < 5; i++) geolocation.emit(position({ speed: 6 }));
}

describe("GeolocationRecordingEngine", () => {
  it("walks acquiring → armed → recording with backdated takeoff", async () => {
    const engine = createEngine();
    const statuses: EngineStatus[] = [];
    engine.on("status", (status) => statuses.push(status));

    await engine.start();
    expect(statuses).toEqual(["acquiring"]);

    geolocation.emit(position({ accuracy: 40 }));
    geolocation.emit(position());
    geolocation.emit(position());
    expect(statuses).toEqual(["acquiring"]);
    geolocation.emit(position());
    expect(statuses).toEqual(["acquiring", "armed"]);

    const movementStart = timestamp + 1000;
    geolocation.emit(position({ speed: 2 }));
    geolocation.emit(position({ speed: 3 }));
    for (let i = 0; i < 5; i++) geolocation.emit(position({ speed: 6 }));
    expect(statuses).toEqual(["acquiring", "armed", "recording"]);

    const snapshot = await engine.getSnapshot();
    expect(snapshot.status).toBe("recording");
    expect(snapshot.startedAt).toBe(movementStart);
    expect(snapshot.track[0].speed).toBe(2);
  });

  it("rehydrates a recording from the WAL in a fresh instance", async () => {
    const first = createEngine();
    await armAndTakeOff(first);
    const before = await first.getSnapshot();
    expect(before.status).toBe("recording");

    const reborn = createEngine();
    const snapshot = await reborn.getSnapshot();
    expect(snapshot.status).toBe("recording");
    expect(snapshot.startedAt).toBe(before.startedAt);
    expect(snapshot.track).toEqual(before.track);
    expect(geolocation.watcherCount).toBeGreaterThan(0);
  });

  it("stop returns the flight and clears the WAL", async () => {
    const engine = createEngine();
    await armAndTakeOff(engine);
    const track = await engine.stop();
    expect(track.length).toBe(7);
    expect(track[0].speed).toBe(2);

    const fresh = createEngine();
    const snapshot = await fresh.getSnapshot();
    expect(snapshot.status).toBe("idle");
    expect(snapshot.track).toEqual([]);
  });

  it("derives speed and course when the platform omits them", async () => {
    const engine = createEngine();
    const fixes: number[][] = [];
    engine.on("fix", (fix) => fixes.push([fix.speed, fix.course]));
    await engine.start();

    geolocation.emit(position({ speed: null, heading: null }));
    // ~11.1 m north in 1 s ≈ 11.1 m/s heading 0
    geolocation.emit(
      position({ latitude: 43.0001, speed: null, heading: null }),
    );

    expect(fixes[0][0]).toBe(0);
    expect(fixes[1][0]).toBeCloseTo(11.1, 0);
    expect(fixes[1][1]).toBeCloseTo(0, 0);
  });

  it("never arms without vertical accuracy", async () => {
    const engine = createEngine();
    const statuses: EngineStatus[] = [];
    engine.on("status", (status) => statuses.push(status));
    await engine.start();
    for (let i = 0; i < 6; i++) {
      geolocation.emit(position({ altitudeAccuracy: null }));
    }
    expect(statuses).toEqual(["acquiring"]);
  });

  it("classifies watch errors", async () => {
    const engine = createEngine();
    const errors: string[] = [];
    engine.on("error", (error) => errors.push(error.code));
    await engine.start();
    geolocation.emitError(1);
    geolocation.emitError(2);
    expect(errors).toEqual(["permission-denied", "unavailable"]);
  });

  it("walks recording → landed → ended on fix time, trimming the tail", async () => {
    const engine = createEngine();
    const statuses: EngineStatus[] = [];
    engine.on("status", (status) => statuses.push(status));
    await armAndTakeOff(engine);

    for (let i = 0; i < LANDING_SUSTAIN_FIXES; i++) {
      geolocation.emit(position({ speed: 0.3 }));
    }
    expect(statuses.at(-1)).toBe("landed");
    const landedSnapshot = await engine.getSnapshot();
    expect(landedSnapshot.landingAt).not.toBeNull();

    // Grace is fix time: more one-second fixes expire it, even emitted in
    // a burst (this IS the backgrounded-landing replay case)
    for (let i = 0; i < 35; i++) {
      geolocation.emit(position({ speed: 0.3 }));
    }
    expect(statuses.at(-1)).toBe("ended");
    expect(geolocation.watcherCount).toBe(0);

    const snapshot = await engine.getSnapshot();
    expect(snapshot.status).toBe("ended");
    // Trimmed at touchdown: taxi + flight + the single touchdown fix
    expect(snapshot.track.map((fix) => fix.speed)).toEqual([
      2, 3, 6, 6, 6, 6, 6, 0.3,
    ]);

    const flown = await engine.stop();
    expect(flown.map((fix) => fix.speed)).toEqual([2, 3, 6, 6, 6, 6, 6, 0.3]);
    const fresh = createEngine();
    expect((await fresh.getSnapshot()).status).toBe("idle");
  });

  it("ended survives death before collection — nothing is lost", async () => {
    const first = createEngine();
    await armAndTakeOff(first);
    for (let i = 0; i < LANDING_SUSTAIN_FIXES + 35; i++) {
      geolocation.emit(position({ speed: 0.3 }));
    }
    expect((await first.getSnapshot()).status).toBe("ended");

    // The webview dies between finalization and persistence: a fresh
    // engine still finds the completed flight in the WAL.
    const reborn = createEngine();
    const snapshot = await reborn.getSnapshot();
    expect(snapshot.status).toBe("ended");
    expect(snapshot.track.map((fix) => fix.speed)).toEqual([
      2, 3, 6, 6, 6, 6, 6, 0.3,
    ]);
  });

  it("dismiss returns landed to recording until movement resumes", async () => {
    const engine = createEngine();
    const statuses: EngineStatus[] = [];
    engine.on("status", (status) => statuses.push(status));
    await armAndTakeOff(engine);

    for (let i = 0; i < LANDING_SUSTAIN_FIXES; i++) {
      geolocation.emit(position({ speed: 0.3 }));
    }
    expect(statuses.at(-1)).toBe("landed");
    engine.dismissLanding();
    expect(statuses.at(-1)).toBe("recording");

    for (let i = 0; i < 40; i++) {
      geolocation.emit(position({ speed: 0.3 }));
    }
    expect(statuses.at(-1)).toBe("recording");

    // Movement clears the dismissal; a fresh landing detects again
    for (let i = 0; i < 5; i++) geolocation.emit(position({ speed: 7 }));
    for (let i = 0; i < LANDING_SUSTAIN_FIXES; i++) {
      geolocation.emit(position({ speed: 0.3 }));
    }
    expect(statuses.at(-1)).toBe("landed");
  });

  it("manual stop after landing detection trims the tail", async () => {
    const engine = createEngine();
    await armAndTakeOff(engine);
    for (let i = 0; i < LANDING_SUSTAIN_FIXES + 5; i++) {
      geolocation.emit(position({ speed: 0.3 }));
    }
    const track = await engine.stop();
    expect(track.map((fix) => fix.speed)).toEqual([2, 3, 6, 6, 6, 6, 6, 0.3]);
  });

  it("drops burst duplicates faster than 500 ms", async () => {
    const engine = createEngine();
    let count = 0;
    engine.on("fix", () => count++);
    await engine.start();
    geolocation.emit(position());
    geolocation.emit(position({}, 44));
    geolocation.emit(position({}, 1000));
    expect(count).toBe(2);
  });
});

describe("session waypoints", () => {
  it("seeds from start options, appends, survives rehydration, clears on stop", async () => {
    const waypoint = { id: "a", latitude: 43, longitude: -89.4, radiusM: 200 };
    const first = createEngine();
    await first.start({ waypoints: [waypoint] });
    expect((await first.getSnapshot()).waypoints).toEqual([waypoint]);
    await first.addWaypoints([{ ...waypoint, id: "b" }]);

    const reborn = createEngine();
    const snapshot = await reborn.getSnapshot();
    expect(snapshot.waypoints.map((w) => w.id)).toEqual(["a", "b"]);

    await reborn.stop();
    expect((await reborn.getSnapshot()).waypoints).toEqual([]);
  });
});

describe("waypoint config pushes", () => {
  it("pushes the session's set when the watch is established and on additions", async () => {
    const pushes: number[] = [];
    const engine = new GeolocationRecordingEngine({
      source: navigatorPositionSource,
      setWaypoints: (waypoints) => pushes.push(waypoints.length),
    });
    engines.push(engine);
    const waypoint = { id: "a", latitude: 43, longitude: -89.4, radiusM: 200 };
    await engine.start({ waypoints: [waypoint] });
    await engine.addWaypoints([{ ...waypoint, id: "b" }]);
    await engine.stop();
    // No push at stop: the watch teardown carries core.stop on both
    // platforms.
    expect(pushes).toEqual([1, 2]);
  });
});
