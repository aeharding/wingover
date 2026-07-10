import { beforeEach, describe, expect, it } from "vitest";

import { GeolocationRecordingEngine } from "./real";
import type { EngineStatus } from "./types";
import { clearWal } from "./wal";

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
  await clearWal();
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
    const engine = new GeolocationRecordingEngine();
    const statuses: EngineStatus[] = [];
    engine.onStatus((status) => statuses.push(status));

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
    const first = new GeolocationRecordingEngine();
    await armAndTakeOff(first);
    const before = await first.getSnapshot();
    expect(before.status).toBe("recording");

    const reborn = new GeolocationRecordingEngine();
    const snapshot = await reborn.getSnapshot();
    expect(snapshot.status).toBe("recording");
    expect(snapshot.startedAt).toBe(before.startedAt);
    expect(snapshot.track).toEqual(before.track);
    expect(geolocation.watcherCount).toBeGreaterThan(0);
  });

  it("stop returns the flight and clears the WAL", async () => {
    const engine = new GeolocationRecordingEngine();
    await armAndTakeOff(engine);
    const track = await engine.stop();
    expect(track.length).toBe(7);
    expect(track[0].speed).toBe(2);

    const fresh = new GeolocationRecordingEngine();
    const snapshot = await fresh.getSnapshot();
    expect(snapshot.status).toBe("idle");
    expect(snapshot.track).toEqual([]);
  });

  it("derives speed and course when the platform omits them", async () => {
    const engine = new GeolocationRecordingEngine();
    const fixes: number[][] = [];
    engine.onFix((fix) => fixes.push([fix.speed, fix.course]));
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
    const engine = new GeolocationRecordingEngine();
    const statuses: EngineStatus[] = [];
    engine.onStatus((status) => statuses.push(status));
    await engine.start();
    for (let i = 0; i < 6; i++) {
      geolocation.emit(position({ altitudeAccuracy: null }));
    }
    expect(statuses).toEqual(["acquiring"]);
  });

  it("classifies watch errors", async () => {
    const engine = new GeolocationRecordingEngine();
    const errors: string[] = [];
    engine.onError((error) => errors.push(error.code));
    await engine.start();
    geolocation.emitError(1);
    geolocation.emitError(2);
    expect(errors).toEqual(["permission-denied", "unavailable"]);
  });

  it("drops burst duplicates faster than 500 ms", async () => {
    const engine = new GeolocationRecordingEngine();
    let count = 0;
    engine.onFix(() => count++);
    await engine.start();
    geolocation.emit(position());
    geolocation.emit(position({}, 44));
    geolocation.emit(position({}, 1000));
    expect(count).toBe(2);
  });
});
