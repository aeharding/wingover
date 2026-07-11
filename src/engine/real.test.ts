import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LANDING_SUSTAIN_FIXES } from "../flight/landing";
import {
  GeolocationRecordingEngine,
  navigatorPositionSource,
  type PositionSource,
  type SourcePosition,
} from "./real";

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

// Change notifications are coalesced per task: yield one macrotask so
// pending notifies (and fake-indexeddb completions) land.
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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

// Drain: discard() awaits each engine's WAL queue, so no test leaves
// fire-and-forget writes to land in the next test's database.
afterEach(async () => {
  for (const engine of engines) await engine.discard();
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
    await engine.start();
    expect(engine.snapshotSync().status).toBe("acquiring");

    geolocation.emit(position({ accuracy: 40 }));
    geolocation.emit(position());
    geolocation.emit(position());
    expect(engine.snapshotSync().status).toBe("acquiring");
    geolocation.emit(position());
    expect(engine.snapshotSync().status).toBe("armed");

    const movementStart = timestamp + 1000;
    geolocation.emit(position({ speed: 2 }));
    geolocation.emit(position({ speed: 3 }));
    for (let i = 0; i < 5; i++) geolocation.emit(position({ speed: 6 }));

    const snapshot = await engine.getSnapshot();
    expect(snapshot.status).toBe("recording");
    expect(snapshot.startedAt).toBe(movementStart);
    expect(snapshot.track[0].speed).toBe(2);
  });

  it("caches the snapshot between changes and refreshes it after", async () => {
    const engine = createEngine();
    await engine.start();
    const before = engine.snapshotSync();
    // Stable identity while nothing changes (useSyncExternalStore contract).
    expect(engine.snapshotSync()).toBe(before);
    geolocation.emit(position());
    const after = engine.snapshotSync();
    expect(after).not.toBe(before);
    expect(after.latest).not.toBeNull();
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

  it("end + discard finalizes the flight and clears the WAL", async () => {
    const engine = createEngine();
    await armAndTakeOff(engine);
    engine.end();
    const track = engine.snapshotSync().track;
    expect(track.length).toBe(7);
    expect(track[0].speed).toBe(2);
    await engine.discard();

    const fresh = createEngine();
    const snapshot = await fresh.getSnapshot();
    expect(snapshot.status).toBe("idle");
    expect(snapshot.track).toEqual([]);
  });

  it("derives speed and course when the platform omits them", async () => {
    const engine = createEngine();
    await engine.start();

    geolocation.emit(position({ speed: null, heading: null }));
    expect(engine.snapshotSync().latest?.speed).toBe(0);

    // ~11.1 m north in 1 s ≈ 11.1 m/s heading 0
    geolocation.emit(
      position({ latitude: 43.0001, speed: null, heading: null }),
    );
    const latest = engine.snapshotSync().latest;
    expect(latest?.speed).toBeCloseTo(11.1, 0);
    expect(latest?.course).toBeCloseTo(0, 0);
  });

  it("never arms without vertical accuracy", async () => {
    const engine = createEngine();
    await engine.start();
    for (let i = 0; i < 6; i++) {
      geolocation.emit(position({ altitudeAccuracy: null }));
    }
    expect(engine.snapshotSync().status).toBe("acquiring");
  });

  it("surfaces watch errors in the snapshot, cleared by the next fix", async () => {
    const engine = createEngine();
    await engine.start();
    geolocation.emitError(1);
    expect(engine.snapshotSync().error?.code).toBe("permission-denied");
    geolocation.emitError(2);
    expect(engine.snapshotSync().error?.code).toBe("unavailable");
    geolocation.emit(position());
    expect(engine.snapshotSync().error).toBeNull();
  });

  it("walks recording → landed → ended on fix time, trimming the tail", async () => {
    const engine = createEngine();
    await armAndTakeOff(engine);
    expect(engine.snapshotSync().status).toBe("recording");

    for (let i = 0; i < LANDING_SUSTAIN_FIXES; i++) {
      geolocation.emit(position({ speed: 0.3 }));
    }
    expect(engine.snapshotSync().status).toBe("landed");
    expect(engine.snapshotSync().landingAt).not.toBeNull();

    // Grace is fix time: more one-second fixes expire it, even emitted in
    // a burst (this IS the backgrounded-landing replay case)
    for (let i = 0; i < 35; i++) {
      geolocation.emit(position({ speed: 0.3 }));
    }
    expect(engine.snapshotSync().status).toBe("ended");
    expect(geolocation.watcherCount).toBe(0);

    const snapshot = await engine.getSnapshot();
    expect(snapshot.status).toBe("ended");
    // Trimmed at touchdown: taxi + flight + the single touchdown fix
    expect(snapshot.track.map((fix) => fix.speed)).toEqual([
      2, 3, 6, 6, 6, 6, 6, 0.3,
    ]);

    await engine.discard();
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
    await armAndTakeOff(engine);

    for (let i = 0; i < LANDING_SUSTAIN_FIXES; i++) {
      geolocation.emit(position({ speed: 0.3 }));
    }
    expect(engine.snapshotSync().status).toBe("landed");
    engine.dismissLanding();
    expect(engine.snapshotSync().status).toBe("recording");

    for (let i = 0; i < 40; i++) {
      geolocation.emit(position({ speed: 0.3 }));
    }
    expect(engine.snapshotSync().status).toBe("recording");

    // Movement clears the dismissal; a fresh landing detects again
    for (let i = 0; i < 5; i++) geolocation.emit(position({ speed: 7 }));
    for (let i = 0; i < LANDING_SUSTAIN_FIXES; i++) {
      geolocation.emit(position({ speed: 0.3 }));
    }
    expect(engine.snapshotSync().status).toBe("landed");
  });

  // The user-reported straight-line bug: sleep during acquiring, wake after
  // takeoff. The whole backlog replays in ONE synchronous task while a
  // snapshot (FlyPage's collect-on-mount) is mid-read. Hydrate-once means
  // that read can never clobber the live buffer/session the burst built.
  it("a snapshot racing a replay burst must not clobber live state", async () => {
    const engine = createEngine();
    await engine.start();
    // WAL read starts now, before the burst, and resolves after it.
    const racing = engine.getSnapshot();

    // Sleep-through-takeoff backlog, delivered in one synchronous task.
    for (let i = 0; i < 3; i++) geolocation.emit(position({ speed: 0 }));
    geolocation.emit(position({ speed: 2 }));
    geolocation.emit(position({ speed: 3 }));
    for (let i = 0; i < 20; i++) geolocation.emit(position({ speed: 6 }));
    await racing;

    // Live delivery continues after the stale read has landed.
    for (let i = 0; i < 8; i++) geolocation.emit(position({ speed: 6 }));

    expect(engine.snapshotSync().status).toBe("recording");
    const snapshot = await engine.getSnapshot();
    expect(snapshot.status).toBe("recording");
    expect(snapshot.track.map((fix) => fix.speed)).toEqual([
      2,
      3,
      ...Array<number>(28).fill(6),
    ]);
  });

  // A backlog replay delivers every missed fix in one synchronous task.
  // Subscribers get ONE coalesced signal after it and read a complete
  // track — there is no per-fix delta stream for a consumer to fall
  // behind on (the failure mode behind the live map's straight line).
  it("a replay burst notifies once, with the complete state readable", async () => {
    const engine = createEngine();
    await engine.start();
    await settle();

    let notifications = 0;
    let trackAtNotify = -1;
    engine.subscribe(() => {
      notifications++;
      trackAtNotify = engine.snapshotSync().track.length;
    });

    for (let i = 0; i < 3; i++) geolocation.emit(position({ speed: 0 }));
    geolocation.emit(position({ speed: 2 }));
    geolocation.emit(position({ speed: 3 }));
    for (let i = 0; i < 20; i++) geolocation.emit(position({ speed: 6 }));
    // Coalesced: nothing fires mid-task.
    expect(notifications).toBe(0);

    await settle();
    expect(notifications).toBe(1);
    expect(trackAtNotify).toBe(22);

    // Live cadence: each subsequent fix is its own change.
    geolocation.emit(position({ speed: 6 }));
    await settle();
    expect(notifications).toBe(2);
    expect(trackAtNotify).toBe(23);
  });

  // Fix-time doctrine, batch edition: a whole flight replayed as ONE
  // onPositions batch (waking after it all happened) must land in exactly
  // the state live per-fix delivery produces — same backdated takeoff,
  // same landing index, same grace expiry, same trimmed track.
  it("a whole-flight batch lands in the state live delivery produces", async () => {
    function manualSource() {
      let deliver: ((batch: SourcePosition[]) => void) | null = null;
      const source: PositionSource = {
        watch(onPositions) {
          deliver = onPositions;
          return () => {
            deliver = null;
          };
        },
      };
      return { source, push: (batch: SourcePosition[]) => deliver?.(batch) };
    }

    const fixture: SourcePosition[] = [];
    for (let i = 0; i < 3; i++) fixture.push(position({ speed: 0 }));
    fixture.push(position({ speed: 2 }));
    fixture.push(position({ speed: 3 }));
    for (let i = 0; i < 5; i++) fixture.push(position({ speed: 6 }));
    for (let i = 0; i < LANDING_SUSTAIN_FIXES + 35; i++) {
      fixture.push(position({ speed: 0.3 }));
    }

    // Live cadence: one batch per fix.
    const liveSource = manualSource();
    const live = new GeolocationRecordingEngine({
      source: liveSource.source,
      setWaypoints: () => {},
    });
    engines.push(live);
    await live.start();
    for (const p of fixture) liveSource.push([p]);
    const liveSnapshot = live.snapshotSync();
    expect(liveSnapshot.status).toBe("ended");
    await live.discard();

    // Replay: everything in one batch, with one coalesced notification.
    const burstSource = manualSource();
    const burst = new GeolocationRecordingEngine({
      source: burstSource.source,
      setWaypoints: () => {},
    });
    engines.push(burst);
    await burst.start();
    await settle();
    let notifications = 0;
    burst.subscribe(() => notifications++);
    burstSource.push(fixture);
    await settle();
    expect(notifications).toBe(1);

    const burstSnapshot = burst.snapshotSync();
    expect(burstSnapshot.status).toBe("ended");
    expect(burstSnapshot.startedAt).toBe(liveSnapshot.startedAt);
    expect(burstSnapshot.landingAt).toBe(liveSnapshot.landingAt);
    expect(burstSnapshot.track).toEqual(liveSnapshot.track);
  });

  it("drops burst duplicates faster than 500 ms", async () => {
    const engine = createEngine();
    await engine.start();
    geolocation.emit(position());
    const first = engine.snapshotSync().latest?.timestamp;
    expect(first).toBeDefined();
    geolocation.emit(position({}, 44));
    expect(engine.snapshotSync().latest?.timestamp).toBe(first);
    geolocation.emit(position({}, 1000));
    expect(engine.snapshotSync().latest?.timestamp).toBe(first! + 1044);
  });
});

describe("journaled stop", () => {
  it("end() finalizes like an expired grace and survives death before collection", async () => {
    const engine = createEngine();
    await armAndTakeOff(engine);
    engine.end();
    expect(engine.snapshotSync().status).toBe("ended");
    expect(geolocation.watcherCount).toBe(0);
    // Drain so the journaled intent is durable, then die before collecting.
    await engine.getSnapshot();

    // The crash window the old stop() had: WAL cleared, flight not yet
    // persisted. The journaled stop leaves the flight waiting instead.
    const reborn = createEngine();
    const snapshot = await reborn.getSnapshot();
    expect(snapshot.status).toBe("ended");
    expect(snapshot.track.map((fix) => fix.speed)).toEqual([
      2, 3, 6, 6, 6, 6, 6,
    ]);
  });

  it("end() after a detected landing trims the stationary tail", async () => {
    const engine = createEngine();
    await armAndTakeOff(engine);
    for (let i = 0; i < LANDING_SUSTAIN_FIXES; i++) {
      geolocation.emit(position({ speed: 0.3 }));
    }
    expect(engine.snapshotSync().status).toBe("landed");
    engine.end();
    const snapshot = await engine.getSnapshot();
    expect(snapshot.status).toBe("ended");
    expect(snapshot.track.map((fix) => fix.speed)).toEqual([
      2, 3, 6, 6, 6, 6, 6, 0.3,
    ]);
  });

  it("end() is meaningless before takeoff (cancel uses discard)", async () => {
    const engine = createEngine();
    await engine.start();
    geolocation.emit(position());
    engine.end();
    expect(engine.snapshotSync().status).toBe("acquiring");
  });
});

describe("storage failure", () => {
  it("surfaces WAL write failure, retains the fixes, and recovers", async () => {
    const engine = createEngine();
    await armAndTakeOff(engine);
    await engine.getSnapshot(); // drain: everything so far is durable

    const workingIndexedDB = globalThis.indexedDB;
    globalThis.indexedDB = {
      open() {
        throw new Error("quota exceeded");
      },
    } as unknown as IDBFactory;

    geolocation.emit(position({ speed: 6 }));
    await settle();
    expect(engine.snapshotSync().error?.code).toBe("storage");

    // GPS flowing must NOT clear a storage error — different channel.
    geolocation.emit(position({ speed: 6 }));
    await settle();
    expect(engine.snapshotSync().error?.code).toBe("storage");

    // The outage's fixes were retained, not eaten: when storage recovers,
    // the next flush lands them and only then does the error clear.
    globalThis.indexedDB = workingIndexedDB;
    geolocation.emit(position({ speed: 6 }));
    await settle();
    expect(engine.snapshotSync().error).toBeNull();
    await engine.getSnapshot(); // drain

    const reborn = createEngine();
    const snapshot = await reborn.getSnapshot();
    expect(snapshot.track.map((fix) => fix.speed)).toEqual([
      2, 3, 6, 6, 6, 6, 6, 6, 6, 6,
    ]);
  });
});

describe("recorder lock", () => {
  function installFakeLocks() {
    let held = false;
    const locks = {
      request: async (
        _name: string,
        _options: unknown,
        callback: (lock: unknown) => unknown,
      ) => {
        if (held) return callback(null);
        held = true;
        try {
          return await callback({});
        } finally {
          held = false;
        }
      },
    };
    (navigator as unknown as { locks: unknown }).locks = locks;
  }

  it("a second engine cannot take the recorder while the first holds it", async () => {
    installFakeLocks();
    const first = createEngine();
    await first.start();
    expect(first.snapshotSync().status).toBe("acquiring");

    // Second tab: start refuses BEFORE touching the WAL.
    const second = createEngine();
    await second.start();
    expect(second.snapshotSync().status).toBe("idle");
    expect(second.snapshotSync().error?.code).toBe("busy");

    // Only the holder consumes fixes.
    geolocation.emit(position());
    expect(first.snapshotSync().latest).not.toBeNull();
    expect(second.snapshotSync().latest).toBeNull();

    // Discard releases the lock; the second tab can now record.
    await first.discard();
    await second.start();
    expect(second.snapshotSync().status).toBe("acquiring");
    expect(second.snapshotSync().error).toBeNull();
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

    await reborn.discard();
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
    await engine.discard();
    // No push at discard: the watch teardown carries core.stop on both
    // platforms.
    expect(pushes).toEqual([1, 2]);
  });
});
