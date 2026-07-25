import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LANDING_SUSTAIN_FIXES } from "../flight/landing";
import { IMPRECISE_SUSTAIN_MS } from "../flight/takeoff";
import { createWaypointTracker, WAYPOINT_RADIUS_M } from "../flight/waypoints";
import { BOOT_HYDRATION_TIMEOUT_MS } from "./bootGate";
import {
  GeolocationRecordingEngine,
  navigatorPositionSource,
  type PositionSource,
  type SourceError,
  type SourcePosition,
} from "./real";
import { readWal } from "./wal";

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

// The same fix as `position()`, in the shape a non-browser source
// delivers: full accuracy and an altitude, so nothing reads as reduced.
function sourceFix(): SourcePosition {
  timestamp += 1000;
  return {
    timestamp,
    coords: {
      latitude: 43.0,
      longitude: -89.4,
      accuracy: 5,
      altitude: 300,
      altitudeAccuracy: 8,
      speed: 0,
      heading: 90,
    },
  };
}

// RECOVERY_POLL_MS in real.ts. Not exported: the interval is an internal
// cadence, and a test that had to know it exactly would be pinning the
// implementation rather than the behaviour.
const POLL_MS = 2_000;

// A stand-in for the native permission round trip a watch makes before it
// can refuse: long enough that the refusal lands after the bounce's own
// optimistic clear has already been observed, which is the ordering that
// re-arms the poll.
const ROUND_TRIP_MS = 10;

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

async function armAndTakeOff(
  engine: GeolocationRecordingEngine,
  options?: Parameters<GeolocationRecordingEngine["start"]>[0],
) {
  await engine.start(options);
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

  it("a watch error after takeoff never blocks the flight", async () => {
    const engine = createEngine();
    await armAndTakeOff(engine);
    expect(engine.snapshotSync().status).toBe("recording");
    geolocation.emitError(1);
    const snapshot = engine.snapshotSync();
    expect(snapshot.status).toBe("recording");
    expect(snapshot.error).toBeNull();
    // Whatever fixes still arrive keep being consumed.
    const length = snapshot.track.length;
    geolocation.emit(position({ speed: 6 }));
    expect(engine.snapshotSync().track.length).toBe(length + 1);
  });

  it("retry() exits blocked straight back into acquiring, never idle", async () => {
    const engine = createEngine();
    await engine.start();
    geolocation.emitError(1);
    expect(engine.snapshotSync().status).toBe("blocked");
    engine.retry();
    expect(engine.snapshotSync().status).toBe("acquiring");
    // The bounced watch is live again.
    geolocation.emit(position());
    expect(engine.snapshotSync().latest).not.toBeNull();
  });

  // A source in the native shape: capture outlives the page, so it
  // declares no watchCanDieSilently and recovery is the readiness poll
  // alone. `fail` stays bound to the FIRST watch's error callback; a
  // bounce installs a fresh one the test never has to touch.
  function pollingSource(ready: () => boolean) {
    const state = {
      watches: 0,
      fail: (() => {}) as (error: SourceError) => void,
    };
    const source: PositionSource = {
      reportsAccuracyAuthorization: true,
      readiness: () => Promise.resolve(ready()),
      watch(_onPositions, onError) {
        state.watches++;
        if (state.watches === 1) state.fail = onError;
        return () => {};
      },
    };
    return { source, state };
  }

  // The Settings round trip, end to end: the pilot revokes location, then
  // sets it back to "Ask Next Time". The native source calls an unasked
  // permission READY (nativeSource.ts), and this poll is what turns that
  // into a watch bounce — the fresh watch is what raises the system
  // prompt. No poll, no prompt: the takeover just sat there until a
  // second trip out of the app happened to bounce the watch some other
  // way. retry() cannot stand in: it is the WEB heal and self-gates off
  // this source's missing watchCanDieSilently.
  it("recovery polling recovers a source retry() will not touch, and not one poll sooner", async () => {
    let ready = false;
    const { source, state } = pollingSource(() => ready);
    const engine = new GeolocationRecordingEngine({
      source,
      setWaypoints: () => {},
    });
    engines.push(engine);
    await engine.start();
    expect(state.watches).toBe(1);

    vi.useFakeTimers();
    try {
      state.fail({
        permissionDenied: true,
        message: "location permission denied",
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(engine.snapshotSync().status).toBe("blocked");

      // Still refused in Settings: polling must not thrash the watch.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(engine.snapshotSync().status).toBe("blocked");
      expect(state.watches).toBe(1);

      // The inverse pin: the foreground heal is inert here even while
      // blocked. Whatever the pilot's return from Settings dispatches,
      // this source's capture is never bounced behind its back — the
      // takeover lifts on the poll's evidence or not at all.
      engine.retry();
      await vi.advanceTimersByTimeAsync(0);
      expect(engine.snapshotSync().status).toBe("blocked");
      expect(state.watches).toBe(1);

      // Flipped to "Ask Next Time": one poll later the session is
      // acquiring again on a fresh watch — the one that does the asking.
      ready = true;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(engine.snapshotSync().status).toBe("acquiring");
      expect(engine.snapshotSync().error).toBeNull();
      expect(state.watches).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // Latency, not just eventual recovery: the poll's first check runs when
  // it arms, so a refusal that is already fixed by the time it lands (the
  // webview rebuilt while the pilot was in Settings) clears in one
  // readiness round trip. Real timers, and the test never waits
  // RECOVERY_POLL_MS — an interval-phased first check would leave it
  // blocked here.
  it("the recovery poll checks the moment it arms, not one interval later", async () => {
    const { source, state } = pollingSource(() => true);
    const engine = new GeolocationRecordingEngine({
      source,
      setWaypoints: () => {},
    });
    engines.push(engine);
    await engine.start();

    state.fail({
      permissionDenied: true,
      message: "location permission denied",
    });
    await settle();
    expect(engine.snapshotSync().status).toBe("acquiring");
    expect(engine.snapshotSync().error).toBeNull();
    expect(state.watches).toBe(2);
  });

  // A readiness() answer is in flight across an unbounded round trip to
  // the platform, and the block it was asked about can end while it
  // travels. Acting on a stale yes tears down a watch that is already
  // delivering — the pilot loses capture to a poll answering a question
  // nobody is asking any more. Two independent guards, pinned separately:
  // a blocking error must still stand, AND the answer must belong to the
  // current arming.
  it("a readiness answer that outlived its block cannot bounce a live watch", async () => {
    const pending: ((ready: boolean) => void)[] = [];
    const state = {
      watches: 0,
      fail: (() => {}) as (error: SourceError) => void,
      feed: (() => {}) as (positions: SourcePosition[]) => void,
    };
    const source: PositionSource = {
      reportsAccuracyAuthorization: true,
      readiness: () => new Promise<boolean>((resolve) => pending.push(resolve)),
      watch(onPositions, onError) {
        state.watches++;
        state.feed = onPositions;
        state.fail = onError;
        return () => {};
      },
    };
    const engine = new GeolocationRecordingEngine({
      source,
      setWaypoints: () => {},
    });
    engines.push(engine);
    await engine.start();
    expect(state.watches).toBe(1);

    // Precise Location off: a blocking error that self-heals on evidence,
    // so the poll can be left holding an answer to a dead question.
    state.fail({
      permissionDenied: false,
      imprecise: true,
      message: "precise location disabled",
    });
    await settle();
    expect(engine.snapshotSync().status).toBe("blocked");
    expect(pending).toHaveLength(1);

    // Precise flipped back on, proven by a good fix: the block ends
    // through ingest, and the watch that ingested is live.
    state.feed([sourceFix()]);
    await settle();
    expect(engine.snapshotSync().status).toBe("acquiring");

    // The stale yes lands. Nothing is blocked, so nothing is bounced.
    pending[0](true);
    await settle();
    expect(state.watches).toBe(1);
    expect(engine.snapshotSync().status).toBe("acquiring");

    // Second guard: a NEW block arms a new poll, and the answer from the
    // OLD one is still not this block's evidence.
    state.fail({
      permissionDenied: false,
      imprecise: true,
      message: "precise location disabled",
    });
    await settle();
    expect(engine.snapshotSync().status).toBe("blocked");
    expect(pending).toHaveLength(2);

    pending[0](true);
    await settle();
    expect(state.watches).toBe(1);
    expect(engine.snapshotSync().status).toBe("blocked");

    // The current arming's own answer is what recovers it.
    pending[1](true);
    await settle();
    expect(state.watches).toBe(2);
    expect(engine.snapshotSync().status).toBe("acquiring");
  });

  it("a readiness that rejects is simply not ready, never an unhandled rejection", async () => {
    const state = {
      watches: 0,
      fail: (() => {}) as (error: SourceError) => void,
    };
    const source: PositionSource = {
      reportsAccuracyAuthorization: true,
      readiness: () => Promise.reject(new Error("plugin not responding")),
      watch(_onPositions, onError) {
        state.watches++;
        if (state.watches === 1) state.fail = onError;
        return () => {};
      },
    };
    const engine = new GeolocationRecordingEngine({
      source,
      setWaypoints: () => {},
    });
    engines.push(engine);
    await engine.start();

    state.fail({
      permissionDenied: true,
      message: "location permission denied",
    });
    await settle();
    // The takeover holds and the watch is untouched; an unhandled
    // rejection at 0.5 Hz would fail this suite outright.
    expect(engine.snapshotSync().status).toBe("blocked");
    expect(state.watches).toBe(1);
  });

  // Readiness and the watch's pre-capture refusal are meant to be ONE rule
  // (nativeSource's permissionRefusal, reading one PermissionStatus that
  // now carries the device-wide switch too), so "ready, then refused" is a
  // contradiction. A platform that produces it anyway — a version where
  // the two disagree, a shell answering stale — must still not make the
  // engine flap: bounce, error re-lands, re-arm, immediate check, bounce,
  // as fast as the round trips allow, with the takeover flickering through
  // acquiring each time. Convergence is structural instead of assumed:
  // only the FIRST arming of an episode checks immediately.
  for (const delivery of ["synchronously", "after a round trip"] as const) {
    it(`a lying platform cannot make the engine thrash: attempts damp to the poll cadence (refused ${delivery})`, async () => {
      let lying = false;
      const state = {
        watches: 0,
        fail: (() => {}) as (error: SourceError) => void,
      };
      const source: PositionSource = {
        reportsAccuracyAuthorization: true,
        // The lie: always ready, whatever the watch then does.
        readiness: () => Promise.resolve(true),
        watch(_onPositions, onError) {
          state.watches++;
          if (state.watches === 1) state.fail = onError;
          const refuse = () => {
            if (!lying) return;
            onError({
              permissionDenied: true,
              message: "location permission denied",
            });
          };
          // A native refusal arrives only after a permission round trip
          // (nativeSource awaits check_permissions before judging), long
          // after the bounce's own optimistic clear has been observed; a
          // web one is immediate. The two take different paths through
          // the poll's arm and disarm and must damp the same way.
          if (state.watches > 1) {
            if (delivery === "synchronously") refuse();
            else setTimeout(refuse, ROUND_TRIP_MS);
          }
          return () => {};
        },
      };
      const engine = new GeolocationRecordingEngine({
        source,
        setWaypoints: () => {},
      });
      engines.push(engine);
      await engine.start();
      expect(state.watches).toBe(1);

      vi.useFakeTimers();
      try {
        lying = true;
        state.fail({
          permissionDenied: true,
          message: "location permission denied",
        });
        await vi.advanceTimersByTimeAsync(0);
        // The block arms and buys exactly ONE immediate attempt.
        expect(state.watches).toBe(2);
        // Once the refusal is back, the takeover is standing again — and
        // the re-arm it causes does NOT buy a second attempt.
        await vi.advanceTimersByTimeAsync(ROUND_TRIP_MS);
        expect(engine.snapshotSync().status).toBe("blocked");
        expect(state.watches).toBe(2);

        // Nor does any amount of settling short of the interval: no tight
        // loop, no takeover flickering through acquiring.
        await vi.advanceTimersByTimeAsync(0);
        expect(state.watches).toBe(2);
        expect(engine.snapshotSync().status).toBe("blocked");

        // Each interval buys at most one more attempt. The trailing
        // round-trip advance lets a refusal still in flight land before
        // judging: an attempt in PROGRESS legitimately reads acquiring
        // until the platform answers, and it is the RATE of attempts
        // being damped.
        for (let k = 1; k <= 5; k++) {
          await vi.advanceTimersByTimeAsync(POLL_MS);
          await vi.advanceTimersByTimeAsync(ROUND_TRIP_MS);
          expect(engine.snapshotSync().status).toBe("blocked");
          expect(state.watches).toBeLessThanOrEqual(k + 2);
        }
        // Damped, not wedged: it is still trying.
        expect(state.watches).toBeGreaterThan(2);

        // And stability is not deadlock: the moment the platform stops
        // lying, the next attempt recovers.
        lying = false;
        await vi.advanceTimersByTimeAsync(POLL_MS);
        await vi.advanceTimersByTimeAsync(ROUND_TRIP_MS);
        expect(engine.snapshotSync().status).toBe("acquiring");
        expect(engine.snapshotSync().error).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  }

  it("a passive (busy) tab can never destroy the owner's WAL, and mid-flight adoption stays a viewer", async () => {
    // Owner records a flight (lock-less env: owner by default).
    const owner = createEngine();
    await armAndTakeOff(owner);
    await owner.getSnapshot(); // drain WAL queue: session + fixes durable
    // Second tab: the recorder lock is now refused.
    (globalThis.navigator as unknown as { locks: unknown }).locks = {
      request: (_name: string, _opts: unknown, cb: (lock: null) => unknown) =>
        Promise.resolve(cb(null)),
    };
    const viewer = createEngine();
    await viewer.getSnapshot();
    // Mid-flight adoption: read-only viewer, never a blocking screen.
    expect(viewer.snapshotSync().status).toBe("recording");
    expect(viewer.snapshotSync().error).toBeNull();
    // Cancel in the second tab (discard) must not touch the owner's WAL.
    await viewer.discard();
    const { session } = await readWal();
    expect(session).not.toBeNull();
    expect(session?.takeoffIndex).not.toBeNull();
  });

  it("a pre-takeoff busy tab blocks, and its only exit still preserves the owner's WAL", async () => {
    const owner = createEngine();
    await owner.start();
    await owner.getSnapshot();
    (globalThis.navigator as unknown as { locks: unknown }).locks = {
      request: (_name: string, _opts: unknown, cb: (lock: null) => unknown) =>
        Promise.resolve(cb(null)),
    };
    const passive = createEngine();
    await passive.getSnapshot();
    const snapshot = passive.snapshotSync();
    expect(snapshot.status).toBe("blocked");
    expect(snapshot.error?.code).toBe("busy");
    // retry() must not bounce a watch it does not own.
    passive.retry();
    expect(passive.snapshotSync().status).toBe("blocked");
    await passive.discard();
    const { session } = await readWal();
    expect(session).not.toBeNull();
  });

  it("retry() during recording is a no-op: a started flight's source is never touched", async () => {
    const engine = createEngine();
    await armAndTakeOff(engine);
    const before = engine.snapshotSync();
    engine.retry();
    const after = engine.snapshotSync();
    expect(after.status).toBe("recording");
    expect(after).toBe(before);
    // The original watch is still the live one.
    geolocation.emit(position({ speed: 6 }));
    expect(engine.snapshotSync().track.length).toBe(before.track.length + 1);
  });

  it("a storage failure never tears down an installed blocking takeover", async () => {
    const engine = createEngine();
    await engine.start();
    geolocation.emitError(1);
    expect(engine.snapshotSync().status).toBe("blocked");
    // The real path needs a live IndexedDB connection severed mid-write
    // (fake-indexeddb cannot express it), so drive the WAL queue's
    // rejection handler directly.
    (
      engine as unknown as {
        enqueueWal: (op: () => Promise<void>) => void;
      }
    ).enqueueWal(() => Promise.reject(new Error("severed")));
    await settle();
    const snapshot = engine.snapshotSync();
    expect(snapshot.status).toBe("blocked");
    expect(snapshot.error?.code).toBe("permission-denied");
  });

  it("blocked imprecise self-heals on a good fix; the others absorb", async () => {
    const engine = createEngine();
    await engine.start();
    vi.useFakeTimers();
    try {
      geolocation.emit(
        position({ accuracy: 13_000, altitude: null, altitudeAccuracy: null }),
      );
      await vi.advanceTimersByTimeAsync(IMPRECISE_SUSTAIN_MS + 1);
      expect(engine.snapshotSync().status).toBe("blocked");
      // Still-coarse fixes keep absorbing (no flap)...
      geolocation.emit(
        position({ accuracy: 13_000, altitude: null, altitudeAccuracy: null }),
      );
      expect(engine.snapshotSync().status).toBe("blocked");
      // ...but one good fix disproves the diagnosis and resumes ingest.
      geolocation.emit(position());
      const snapshot = engine.snapshotSync();
      expect(snapshot.status).toBe("acquiring");
      expect(snapshot.error).toBeNull();
      expect(snapshot.latest).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retry() while acquiring bounces the watch and keeps the session", async () => {
    const engine = createEngine();
    await engine.start();
    geolocation.emit(position());
    const before = engine.snapshotSync().latest;
    expect(before).not.toBeNull();
    engine.retry();
    // Still the same acquiring session with its buffer...
    expect(engine.snapshotSync().status).toBe("acquiring");
    expect(engine.snapshotSync().latest).toBe(before);
    // ...and the fresh watch delivers.
    geolocation.emit(position());
    expect(engine.snapshotSync().latest).not.toBe(before);
  });

  it("latches imprecise from a LONE reduced fix after the sustain window", async () => {
    const engine = createEngine();
    await engine.start();
    vi.useFakeTimers();
    try {
      // One kilometer-coarse, altitude-less fix, then silence — the
      // grid-pinned source shape that a count-based check never catches.
      geolocation.emit(
        position({ accuracy: 13_000, altitude: null, altitudeAccuracy: null }),
      );
      expect(engine.snapshotSync().status).toBe("acquiring");
      await vi.advanceTimersByTimeAsync(IMPRECISE_SUSTAIN_MS + 1);
      const snapshot = engine.snapshotSync();
      expect(snapshot.status).toBe("blocked");
      expect(snapshot.error?.code).toBe("imprecise");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a pending storage error does not mask the imprecise latch", async () => {
    const engine = createEngine();
    await engine.start();
    vi.useFakeTimers();
    try {
      geolocation.emit(
        position({ accuracy: 13_000, altitude: null, altitudeAccuracy: null }),
      );
      // A Settings trip backgrounds Safari and severs IndexedDB, so the
      // WAL flush fails right after the reduced fix ingests — plant the
      // resulting storage error between arm and fire (private-field
      // poke: the real failure path needs a severed live connection,
      // which fake-indexeddb cannot express).
      (engine as unknown as { error: unknown }).error = {
        code: "storage",
        message: "severed",
      };
      await vi.advanceTimersByTimeAsync(IMPRECISE_SUSTAIN_MS + 1);
      const snapshot = engine.snapshotSync();
      expect(snapshot.status).toBe("blocked");
      expect(snapshot.error?.code).toBe("imprecise");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a non-reduced fix disarms the imprecise latch", async () => {
    const engine = createEngine();
    await engine.start();
    vi.useFakeTimers();
    try {
      geolocation.emit(
        position({ accuracy: 13_000, altitude: null, altitudeAccuracy: null }),
      );
      await vi.advanceTimersByTimeAsync(IMPRECISE_SUSTAIN_MS / 2);
      geolocation.emit(position());
      await vi.advanceTimersByTimeAsync(IMPRECISE_SUSTAIN_MS * 2);
      expect(engine.snapshotSync().status).toBe("acquiring");
      expect(engine.snapshotSync().error).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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

describe("landing finalization", () => {
  // The user-facing contract: the sustain wait and the grace tail belong
  // to DETECTION, not to the flight. The flight of record is clipped at
  // the first fix that met the landing threshold.
  it("auto-end clips the flight at the first sub-threshold fix", async () => {
    const engine = createEngine();
    await armAndTakeOff(engine);
    const touchdownTs = timestamp + 1000;
    for (let i = 0; i < LANDING_SUSTAIN_FIXES + 35; i++) {
      geolocation.emit(position({ speed: 0.3 }));
    }
    const snapshot = await engine.getSnapshot();
    expect(snapshot.status).toBe("ended");
    expect(snapshot.landingAt).toBe(touchdownTs);
    expect(snapshot.track[snapshot.track.length - 1].timestamp).toBe(
      touchdownTs,
    );
  });

  // The field regression (flight of 2026-07-10): packing up at walking
  // pace never completed the old 1.0 m/s sustain window, so the whole
  // walk-around saved into the flight of record.
  it("a walking-pace tail detects, auto-ends, and clips at touchdown", async () => {
    const engine = createEngine();
    await armAndTakeOff(engine);
    const touchdownTs = timestamp + 1000;
    for (let i = 0; i < LANDING_SUSTAIN_FIXES; i++) {
      geolocation.emit(position({ speed: 1.2 + (i % 3) * 0.4 }));
    }
    expect(engine.snapshotSync().status).toBe("landed");
    // Walking must not UN-detect the landing; grace expires through it.
    for (let i = 0; i < 35; i++) {
      geolocation.emit(position({ speed: 1.4 }));
    }
    const snapshot = await engine.getSnapshot();
    expect(snapshot.status).toBe("ended");
    expect(snapshot.landingAt).toBe(touchdownTs);
    expect(snapshot.track[snapshot.track.length - 1].timestamp).toBe(
      touchdownTs,
    );
  });

  it("autoEnd off: grace expiry never finalizes — the pilot decides", async () => {
    const engine = createEngine();
    await armAndTakeOff(engine, { autoEnd: false });
    const touchdownTs = timestamp + 1000;
    for (let i = 0; i < LANDING_SUSTAIN_FIXES + 35; i++) {
      geolocation.emit(position({ speed: 0.3 }));
    }
    // Far past the grace window, still prompting.
    expect(engine.snapshotSync().status).toBe("landed");
    expect(engine.snapshotSync().autoEnd).toBe(false);
    await engine.getSnapshot();

    // The choice is flight-scoped and survives a webview death.
    const reborn = createEngine();
    expect((await reborn.getSnapshot()).status).toBe("landed");

    // The pilot's own end still finalizes, clipped at touchdown.
    reborn.end();
    const snapshot = reborn.snapshotSync();
    expect(snapshot.status).toBe("ended");
    expect(snapshot.track[snapshot.track.length - 1].timestamp).toBe(
      touchdownTs,
    );
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

describe("stale-flight gap detection (app gone mid-flight)", () => {
  it("ends the flight at the fix before a >15 min gap in the stream", async () => {
    const engine = createEngine();
    await armAndTakeOff(engine);
    expect(engine.snapshotSync().status).toBe("recording");
    const lastBeforeGap = engine.snapshotSync().track.at(-1)!.timestamp;

    // The app was gone; the next fix arrives 20 min later. Nothing recorded
    // in between → the flight ended at the last fix before the gap, and the
    // post-gap fix is a separate sitting, not part of it.
    geolocation.emit(position({ speed: 6 }, 20 * 60 * 1000));

    const snapshot = await engine.getSnapshot();
    expect(snapshot.status).toBe("ended");
    expect(snapshot.track.map((fix) => fix.speed)).toEqual([
      2, 3, 6, 6, 6, 6, 6,
    ]);
    expect(snapshot.track.at(-1)!.timestamp).toBe(lastBeforeGap);
    // Consuming stopped — no watch left on the dead flight.
    expect(geolocation.watcherCount).toBe(0);
  });

  it("keeps recording across a continuous replayed backlog (native background)", async () => {
    // The webview died but native capture kept running. On rebirth the
    // native queue replays a long, CONTINUOUS backlog — consecutive fixes
    // never more than a couple minutes apart. That is NOT a gap: the flight
    // must keep recording and the backlog must NOT be lost.
    const first = createEngine();
    await armAndTakeOff(first);
    await first.getSnapshot();

    const reborn = createEngine();
    await reborn.getSnapshot();
    expect(reborn.snapshotSync().status).toBe("recording");
    const before = reborn.snapshotSync().track.length;

    // 30 minutes of background fixes, one a minute (well under the 15 min
    // gap), replayed after the fact.
    for (let i = 0; i < 30; i++) {
      geolocation.emit(position({ speed: 6 }, 60_000));
    }

    const snapshot = await reborn.getSnapshot();
    expect(snapshot.status).toBe("recording");
    expect(snapshot.track.length).toBe(before + 30);
  });

  it("a reborn engine ends when GPS returns >15 min after the last fix", async () => {
    // Phone died mid-flight; the app is reopened and GPS reacquires much
    // later. The reborn engine replays (nothing new), then the first fresh
    // fix is >15 min on — a gap — so the flight ends at the last real fix.
    const first = createEngine();
    await armAndTakeOff(first);
    const lastFixTs = timestamp;
    const flownSpeeds = first.snapshotSync().track.map((fix) => fix.speed);
    await first.getSnapshot();

    const reborn = createEngine();
    await reborn.getSnapshot();
    expect(reborn.snapshotSync().status).toBe("recording");

    geolocation.emit(position({ speed: 3 }, 30 * 60 * 1000));

    const snapshot = await reborn.getSnapshot();
    expect(snapshot.status).toBe("ended");
    expect(snapshot.track.map((fix) => fix.speed)).toEqual(flownSpeeds);
    expect(snapshot.track.at(-1)!.timestamp).toBe(lastFixTs);
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
    // the next flush lands them and only then does the error clear. The
    // clear rides the write's completion — several IDB task hops, so poll
    // rather than assume one macrotask reaches it (it flakes under load).
    globalThis.indexedDB = workingIndexedDB;
    geolocation.emit(position({ speed: 6 }));
    await expect
      .poll(() => engine.snapshotSync().error, { timeout: 5000 })
      .toBeNull();
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

    // Second tab: start refuses BEFORE touching the WAL, and the refusal
    // is a first-class blocked state (the error screen owns the surface).
    const second = createEngine();
    await second.start();
    expect(second.snapshotSync().status).toBe("blocked");
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

// The boot gate (src/engine/bootGate.ts) holds the app's first commit to
// shell-vs-flight-surface until this promise settles, so hydration's TIMING
// is a product contract now and not just an internal: these pin the two
// things the gate depends on. A read that lands fast keeps the wait
// invisible; a read that cannot land at all must still settle, or every
// launch on a broken store pays the gate's whole deadline.
describe("boot hydration", () => {
  it("resolves a relaunch far inside the gate's deadline", async () => {
    const first = createEngine();
    await armAndTakeOff(first);
    await first.getSnapshot(); // drain: the flight is durable

    // The relaunch, and the exact call the gate awaits: one getSnapshot on a
    // fresh engine over the WAL the last one left.
    const relaunched = createEngine();
    const outcome = await Promise.race([
      relaunched.getSnapshot().then((snapshot) => snapshot.status),
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 500)),
    ]);
    expect(outcome).toBe("recording");
    // And the deadline is not what made that true.
    expect(BOOT_HYDRATION_TIMEOUT_MS).toBeGreaterThan(500);
  });

  it("rejects instead of hanging when the WAL cannot be opened", async () => {
    // The gate opens on either arm, so what matters here is that the promise
    // SETTLES: a launch on a dead store boots the ordinary way immediately
    // instead of sitting out the deadline first.
    const workingIndexedDB = globalThis.indexedDB;
    globalThis.indexedDB = {
      open() {
        throw new Error("storage unavailable");
      },
    } as unknown as IDBFactory;

    try {
      const engine = createEngine();
      const outcome = await Promise.race([
        engine.getSnapshot().then(
          () => "hydrated",
          () => "rejected",
        ),
        new Promise((resolve) => setTimeout(() => resolve("hung"), 500)),
      ]);
      expect(outcome).toBe("rejected");
    } finally {
      // Restored even on failure: every later test in this file reads the
      // same global, and a leaked stub cascades into unrelated red.
      globalThis.indexedDB = workingIndexedDB;
    }
  });
});

describe("session waypoints", () => {
  it("seeds planned; ad-hoc is a separate group; survives rehydration; clears on discard", async () => {
    const a = {
      id: "a",
      latitude: 43.03,
      longitude: -89.4,
      radiusM: WAYPOINT_RADIUS_M,
    };
    const first = createEngine();
    await first.start({ waypoints: [a] });

    let snap = await first.getSnapshot();
    expect(snap.waypoints).toEqual([a]);
    expect(snap.adhocWaypoints).toEqual([]);
    expect(snap.waypointsCursor).toBe(0);
    expect(snap.nextWaypoint).toEqual(a);

    // New API: [longitude, latitude] tuple; id + radius are minted.
    await first.addAdhocWaypoint([-89.401, 43.001]);
    snap = await first.getSnapshot();
    expect(snap.waypoints).toEqual([a]); // planned untouched
    expect(snap.adhocWaypoints).toHaveLength(1);
    expect(snap.adhocWaypoints[0]).toMatchObject({
      latitude: 43.001,
      longitude: -89.401,
      radiusM: WAYPOINT_RADIUS_M,
    });
    expect(snap.nextWaypoint).toEqual(snap.adhocWaypoints[0]); // ad-hoc wins

    // Both groups survive a webview death.
    const reborn = createEngine();
    const r = await reborn.getSnapshot();
    expect(r.waypoints).toEqual([a]);
    expect(r.adhocWaypoints).toHaveLength(1);
    expect(r.adhocWaypoints[0].latitude).toBe(43.001);
    expect(r.waypointsCursor).toBe(0);

    await reborn.discard();
    const cleared = await reborn.getSnapshot();
    expect(cleared.waypoints).toEqual([]);
    expect(cleared.adhocWaypoints).toEqual([]);
    expect(cleared.waypointsCursor).toBe(0);
    expect(cleared.nextWaypoint).toBeNull();
  });
});

describe("waypoint config pushes", () => {
  it("feeds the active remaining set on start, add, reach, and remove", async () => {
    const pushes: number[] = [];
    const engine = new GeolocationRecordingEngine({
      source: navigatorPositionSource,
      setWaypoints: (waypoints) => pushes.push(waypoints.length),
    });
    engines.push(engine);
    const far = {
      id: "a",
      latitude: 43.03,
      longitude: -89.4,
      radiusM: WAYPOINT_RADIUS_M,
    };

    // ensureWatch feeds active = [far] -> 1. Arm/takeoff fixes at 43.0 are
    // outside far, so no reach, no extra push.
    await armAndTakeOff(engine, { waypoints: [far] });
    // Ad-hoc prepends -> active [x, far] -> 2.
    await engine.addAdhocWaypoint([-89.4, 43.01]);
    // Reach far (armed outside during takeoff) -> active [x] -> 1.
    geolocation.emit(position({ latitude: 43.03, speed: 6 }));
    await settle();
    // Remove the front (x) -> active [] -> 0.
    await engine.removeWaypoint(engine.snapshotSync().nextWaypoint!.id);

    await engine.discard(); // no push: watch teardown carries core.stop
    expect(pushes).toEqual([1, 2, 1, 0]);
  });
});

describe("waypoint navigation", () => {
  // radiusM = 321.8688 m. At lat 43, 1° lat ≈ 111 194.93 m. Launch is (43.0,
  // -89.4) — armAndTakeOff never moves, so any waypoint off 43.0 arms OUTSIDE
  // during takeoff and a later fix at its latitude crosses in. Keep test
  // waypoints ≥ 0.01° (1112 m) apart so their 322 m rings never overlap,
  // except where a boundary/overlap is deliberately exercised.
  const wp = (id: string, latitude: number, longitude = -89.4) => ({
    id,
    latitude,
    longitude,
    radiusM: WAYPOINT_RADIUS_M,
  });
  const drive = (latitude: number, longitude = -89.4) =>
    geolocation.emit(position({ latitude, longitude, speed: 6 }));

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

  // N1
  it("snapshot exposes waypoints, adhocWaypoints, waypointsCursor, nextWaypoint", async () => {
    const engine = createEngine();
    const far = wp("a", 43.03);
    await engine.start({ waypoints: [far] });
    const snap = await engine.getSnapshot();
    expect(snap.waypoints).toEqual([far]);
    expect(snap.adhocWaypoints).toEqual([]);
    expect(snap.waypointsCursor).toBe(0);
    expect(snap.nextWaypoint).toEqual(far);
    expect(snap.activeWaypoints).toEqual([far]);
  });

  // N2
  it("reaching a planned waypoint advances the cursor (derived, transition)", async () => {
    const engine = createEngine();
    const far = wp("a", 43.03);
    await armAndTakeOff(engine, { waypoints: [far] });
    expect(engine.snapshotSync().waypointsCursor).toBe(0);
    expect(engine.snapshotSync().nextWaypoint).toEqual(far);
    drive(43.03); // cross into far
    expect(engine.snapshotSync().waypointsCursor).toBe(1);
    expect(engine.snapshotSync().nextWaypoint).toBeNull();
    drive(43.03); // dwelling: already passed, idempotent
    expect(engine.snapshotSync().waypointsCursor).toBe(1);
  });

  // N3 — RED-critical: raw proximity would advance here.
  it("launching inside a waypoint neither advances nor skips it", async () => {
    const engine = createEngine();
    const atLaunch = wp("a", 43.0); // fixes at 43.0 are inside its 322 m ring
    await armAndTakeOff(engine, { waypoints: [atLaunch] });
    expect(engine.snapshotSync().waypointsCursor).toBe(0);
    expect(engine.snapshotSync().nextWaypoint).toEqual(atLaunch);
  });

  // N4
  it("reach fires at the 322 m boundary (<= radius), not just outside it", async () => {
    const engine = createEngine();
    await armAndTakeOff(engine, { waypoints: [wp("a", 43.03)] }); // armed outside
    drive(43.033); // 333.6 m out
    expect(engine.snapshotSync().waypointsCursor).toBe(0);
    drive(43.0328); // 311.3 m in
    expect(engine.snapshotSync().waypointsCursor).toBe(1);
  });

  // N5
  it("a dropped sub-500 ms duplicate never advances", async () => {
    const engine = createEngine();
    await armAndTakeOff(engine, { waypoints: [wp("a", 43.03)] });
    geolocation.emit(position({ latitude: 43.03, speed: 6 }, 44)); // dropped
    expect(engine.snapshotSync().waypointsCursor).toBe(0);
    geolocation.emit(position({ latitude: 43.03, speed: 6 }, 1000)); // survives
    expect(engine.snapshotSync().waypointsCursor).toBe(1);
  });

  // N6
  it("ad-hoc waypoints queue FIFO, ahead of the plan", async () => {
    const engine = createEngine();
    await armAndTakeOff(engine, { waypoints: [wp("far", 43.03)] });
    await engine.addAdhocWaypoint([-89.4, 43.01]); // x1
    await engine.addAdhocWaypoint([-89.4, 43.02]); // x2
    const snap = engine.snapshotSync();
    expect(snap.adhocWaypoints.map((w) => w.latitude)).toEqual([43.01, 43.02]);
    expect(snap.nextWaypoint).toEqual(snap.adhocWaypoints[0]); // FIFO head
    expect(snap.waypointsCursor).toBe(0);
    // Numbered nav order: ad-hoc x1, x2, then the planned far.
    expect(snap.activeWaypoints.map((w) => w.latitude)).toEqual([
      43.01, 43.02, 43.03,
    ]);
  });

  // N7
  it("passing ad-hoc drains the queue, then the plan resumes", async () => {
    const engine = createEngine();
    const far = wp("far", 43.03);
    await armAndTakeOff(engine, { waypoints: [far] });
    await engine.addAdhocWaypoint([-89.4, 43.01]); // x1
    await engine.addAdhocWaypoint([-89.4, 43.02]); // x2
    drive(43.0); // arm x1/x2 outside
    drive(43.01); // reach x1
    let snap = engine.snapshotSync();
    expect(snap.adhocWaypoints.map((w) => w.latitude)).toEqual([43.02]);
    expect(snap.nextWaypoint?.latitude).toBe(43.02);
    drive(43.02); // reach x2
    snap = engine.snapshotSync();
    expect(snap.adhocWaypoints).toEqual([]);
    expect(snap.nextWaypoint).toEqual(far);
    expect(snap.waypointsCursor).toBe(0);
    drive(43.03); // reach far
    snap = engine.snapshotSync();
    expect(snap.nextWaypoint).toBeNull();
    expect(snap.waypointsCursor).toBe(1);
  });

  // N8 — RED-critical: without addedAtIndex the reborn replay would count the
  // pre-add crossing and mark the ad-hoc reached.
  it("an ad-hoc added after overflying its spot is not falsely reached", async () => {
    const first = createEngine();
    await armAndTakeOff(first); // no planned
    drive(43.017); // a genuine cross THROUGH 43.02 while nothing is armed there
    drive(43.02);
    drive(43.023);
    await first.addAdhocWaypoint([-89.4, 43.02]); // long-pressed after the fact
    await first.getSnapshot(); // drain

    const reborn = createEngine();
    const snap = await reborn.getSnapshot();
    expect(snap.nextWaypoint?.latitude).toBe(43.02); // still active, not reached
  });

  // N9 — remove the current target by id → the plan advances.
  it("removing the next planned waypoint advances the plan", async () => {
    const engine = createEngine();
    await armAndTakeOff(engine, {
      waypoints: [wp("a", 43.03), wp("b", 43.06)],
    });
    await engine.removeWaypoint("a");
    expect(engine.snapshotSync().waypointsCursor).toBe(1);
    expect(engine.snapshotSync().nextWaypoint?.id).toBe("b");
  });

  // N10 — remove a SPECIFIC waypoint, not the front: the ad-hoc target stays.
  it("removeWaypoint clears the chosen waypoint, leaving the front target", async () => {
    const engine = createEngine();
    const p = wp("p", 43.03);
    await armAndTakeOff(engine, { waypoints: [p] });
    await engine.addAdhocWaypoint([-89.4, 43.01]); // front target now the ad-hoc
    await engine.removeWaypoint("p"); // clear the planned pin behind it
    const snap = engine.snapshotSync();
    expect(snap.nextWaypoint?.latitude).toBe(43.01); // ad-hoc still the target
    expect(snap.activeWaypoints.map((w) => w.latitude)).toEqual([43.01]); // p gone
  });

  // N11 — a no-op for an id that is not currently active.
  it("removeWaypoint is a no-op for an unknown or already-removed id", async () => {
    const pushes: number[] = [];
    const engine = new GeolocationRecordingEngine({
      source: navigatorPositionSource,
      setWaypoints: () => pushes.push(1),
    });
    engines.push(engine);
    await armAndTakeOff(engine, { waypoints: [wp("a", 43.03)] });
    const before = pushes.length;
    await engine.removeWaypoint("nope"); // unknown id: no write, no push
    expect(engine.snapshotSync().nextWaypoint?.id).toBe("a");
    expect(pushes.length).toBe(before);
    await engine.removeWaypoint("a"); // active: removed (one push)
    expect(engine.snapshotSync().nextWaypoint).toBeNull();
    const afterRemoval = pushes.length;
    await engine.removeWaypoint("a"); // already removed: no-op
    expect(pushes.length).toBe(afterRemoval);
  });

  // N11b — remove a middle planned pin; the current target is unchanged.
  it("removing a not-yet-reached middle waypoint keeps the next target", async () => {
    const engine = createEngine();
    await armAndTakeOff(engine, {
      waypoints: [wp("a", 43.03), wp("b", 43.06), wp("c", 43.09)],
    });
    await engine.removeWaypoint("b"); // clear the middle one
    const snap = engine.snapshotSync();
    expect(snap.nextWaypoint?.id).toBe("a"); // still steering to a
    expect(snap.waypointsCursor).toBe(0);
    expect(snap.activeWaypoints.map((w) => w.id)).toEqual(["a", "c"]);
  });

  // N12 — multi-hit in one batch (defects 4/9).
  it("one replayed batch flying through several waypoints advances multiply", async () => {
    const src = manualSource();
    const engine = new GeolocationRecordingEngine({
      source: src.source,
      setWaypoints: () => {},
    });
    engines.push(engine);
    await engine.start({ waypoints: [wp("A", 43.03), wp("B", 43.045)] }); // 1668 m apart
    // Arm + take off at 43.0 (both armed outside).
    const takeoff: SourcePosition[] = [];
    for (let i = 0; i < 3; i++) takeoff.push(position({ speed: 0 }));
    takeoff.push(position({ speed: 2 }));
    takeoff.push(position({ speed: 3 }));
    for (let i = 0; i < 5; i++) takeoff.push(position({ speed: 6 }));
    src.push(takeoff);
    expect(engine.snapshotSync().status).toBe("recording");
    // ONE batch that crosses both A and B (then leaves).
    src.push([
      position({ latitude: 43.03, speed: 6 }),
      position({ latitude: 43.045, speed: 6 }),
      position({ latitude: 43.06, speed: 6 }),
    ]);
    const snap = engine.snapshotSync();
    expect(snap.waypointsCursor).toBe(2);
    expect(snap.nextWaypoint).toBeNull();
  });

  // N12b — a single fix inside two overlapping radii reaches both.
  it("one fix inside two overlapping radii reaches both", async () => {
    const engine = createEngine();
    // A@43.030, B@43.031 — 111 m apart, rings overlap.
    await armAndTakeOff(engine, {
      waypoints: [wp("A", 43.03), wp("B", 43.031)],
    });
    drive(43.0305); // inside both A and B
    const snap = engine.snapshotSync();
    expect(snap.waypointsCursor).toBe(2);
    expect(snap.nextWaypoint).toBeNull();
  });

  // N13 — blocker 1/8: reach emits no session write; reborn re-derives.
  it("a reborn engine re-derives the cursor from the buffer (no journaled reach)", async () => {
    const first = createEngine();
    await armAndTakeOff(first, {
      waypoints: [wp("a", 43.03), wp("b", 43.06)],
    });
    drive(43.03); // reach a
    await first.getSnapshot(); // drain fix flush

    const reborn = createEngine();
    const snap = await reborn.getSnapshot();
    expect(snap.waypointsCursor).toBe(1);
    expect(snap.nextWaypoint?.id).toBe("b");
  });

  // N14 — reborn feeds only the remaining set (passed waypoint not re-armed).
  it("a reborn engine feeds only the un-passed waypoints", async () => {
    const first = createEngine();
    await armAndTakeOff(first, {
      waypoints: [wp("a", 43.03), wp("b", 43.06)],
    });
    drive(43.03); // reach a
    await first.getSnapshot();

    const pushes: string[][] = [];
    const reborn = new GeolocationRecordingEngine({
      source: navigatorPositionSource,
      setWaypoints: (w) => pushes.push(w.map((x) => x.id)),
    });
    engines.push(reborn);
    await reborn.getSnapshot();
    expect(pushes[0]).toEqual(["b"]); // a excluded -> cannot re-announce
  });

  // N15 — the mirror stays in lockstep with the announcer's tracker.
  it("reach count equals the tracker's announcement count over the same path", async () => {
    const waypoints = [wp("A", 43.03), wp("B", 43.06)];
    const path = [43.0, 43.0, 43.03, 43.045, 43.06, 43.07]; // arm outside, cross A, cross B

    // Tracker: count "Waypoint reached" over the identical fed set + path.
    const tracker = createWaypointTracker();
    tracker.setWaypoints(waypoints);
    let announced = 0;
    for (const latitude of path) {
      announced += tracker.ingest({ latitude, longitude: -89.4 }).length;
    }

    // Engine: count cursor advances over the same path.
    const engine = createEngine();
    await armAndTakeOff(engine, { waypoints });
    for (const latitude of path) drive(latitude);
    const advances = engine.snapshotSync().waypointsCursor;

    expect(announced).toBe(2);
    expect(advances).toBe(announced);
  });

  // N16 — ad-hoc reach round-trips and does not resurrect on reborn.
  it("a reached ad-hoc stays passed across a reborn", async () => {
    const first = createEngine();
    const a = wp("a", 43.03);
    await armAndTakeOff(first, { waypoints: [a] });
    await first.addAdhocWaypoint([-89.4, 43.01]);
    drive(43.0); // arm ad-hoc outside
    drive(43.01); // reach the ad-hoc
    await first.getSnapshot();

    const reborn = createEngine();
    const snap = await reborn.getSnapshot();
    expect(snap.adhocWaypoints).toEqual([]); // passed, not resurrected
    expect(snap.nextWaypoint).toEqual(a);
    expect(snap.waypointsCursor).toBe(0);
  });

  // N17 — a finalized flight surfaces no live target.
  it("an ended flight clears nextWaypoint even with waypoints unreached", async () => {
    const engine = createEngine();
    await armAndTakeOff(engine, {
      waypoints: [wp("a", 43.03), wp("b", 43.06)],
    });
    engine.end();
    const snap = engine.snapshotSync();
    expect(snap.status).toBe("ended");
    expect(snap.nextWaypoint).toBeNull();
  });

  // N18 — one fix crossing into an overlapping planned pin AND an ad-hoc
  // (both armed outside first) reaches both, with a single coalesced push.
  it("one fix reaches an overlapping planned + ad-hoc together, pushing once", async () => {
    const pushes: string[][] = [];
    const engine = new GeolocationRecordingEngine({
      source: navigatorPositionSource,
      setWaypoints: (w) => pushes.push(w.map((x) => x.id)),
    });
    engines.push(engine);
    await armAndTakeOff(engine, { waypoints: [wp("p", 43.03)] }); // armed outside
    await engine.addAdhocWaypoint([-89.4, 43.0305]); // 56 m from p — rings overlap
    drive(43.0); // the ad-hoc's first evaluated fix arms it OUTSIDE
    const before = pushes.length;
    drive(43.0305); // one fix inside both rings
    const snap = engine.snapshotSync();
    expect(snap.waypointsCursor).toBe(1); // planned p passed
    expect(snap.adhocWaypoints).toEqual([]); // ad-hoc passed
    expect(snap.nextWaypoint).toBeNull();
    expect(pushes.length).toBe(before + 1); // one coalesced push, not two
  });

  // N19 — an ad-hoc long-pressed while already inside its ring (addedAtIndex
  // == the next fix's index) arms silently, is NOT falsely reached, and only
  // reaches on a real re-entry. Guards the addedAtIndex <= index boundary.
  it("an ad-hoc added inside its own ring arms silently, reaches on re-entry", async () => {
    const engine = createEngine();
    await armAndTakeOff(engine); // no planned
    drive(43.02); // fly to the spot
    await engine.addAdhocWaypoint([-89.4, 43.02]); // long-press where we stand
    drive(43.02); // first evaluated fix is INSIDE -> arm silent, not reached
    expect(engine.snapshotSync().nextWaypoint?.latitude).toBe(43.02);
    drive(43.0); // leave the ring
    expect(engine.snapshotSync().nextWaypoint?.latitude).toBe(43.02);
    drive(43.02); // re-enter: outside -> inside = reached
    expect(engine.snapshotSync().nextWaypoint).toBeNull();
  });

  // N20 — a removed waypoint later physically overflown stays removed
  // (removedIds and reachedIds are disjoint); it never resurfaces as target.
  it("a removed waypoint physically overflown stays removed", async () => {
    const engine = createEngine();
    await armAndTakeOff(engine, {
      waypoints: [wp("a", 43.03), wp("b", 43.06)],
    });
    await engine.removeWaypoint("a"); // remove a
    expect(engine.snapshotSync().nextWaypoint?.id).toBe("b");
    drive(43.03); // fly straight through a's ring
    const snap = engine.snapshotSync();
    expect(snap.nextWaypoint?.id).toBe("b"); // a did NOT re-activate / reach
    expect(snap.waypointsCursor).toBe(1);
    drive(43.06); // b still reachable
    expect(engine.snapshotSync().nextWaypoint).toBeNull();
  });

  // N21 — reach is derived in-memory, independent of the WAL. A flush that
  // fails on the reaching fix still advances the cursor and flags a storage
  // error; a reborn self-heals from the retained + re-flushed buffer.
  it("a reach survives a failed fix-flush and self-heals on reborn", async () => {
    const first = createEngine();
    await armAndTakeOff(first, { waypoints: [wp("a", 43.03)] });
    await first.getSnapshot(); // drain: durable so far

    const workingIndexedDB = globalThis.indexedDB;
    globalThis.indexedDB = {
      open() {
        throw new Error("quota exceeded");
      },
    } as unknown as IDBFactory;

    drive(43.03); // reach a, but the flush fails
    await settle();
    expect(first.snapshotSync().error?.code).toBe("storage");
    expect(first.snapshotSync().waypointsCursor).toBe(1); // derived, not journaled

    // Storage recovers: the retained reaching fix flushes, the error clears.
    globalThis.indexedDB = workingIndexedDB;
    drive(43.03);
    await expect
      .poll(() => first.snapshotSync().error, { timeout: 5000 })
      .toBeNull();
    await first.getSnapshot(); // drain

    const reborn = createEngine();
    const snap = await reborn.getSnapshot();
    expect(snap.waypointsCursor).toBe(1); // self-healed from the buffer
  });

  // N22 — a reach and a >= 15 min stale gap in the SAME batch: the reach is
  // counted, the flight ends at the reaching fix, the track keeps it, and the
  // ended state suppresses the reach re-feed push.
  it("a reach then a stale gap in one batch ends the flight, cursor kept, no re-feed", async () => {
    const pushes: number[] = [];
    const src = manualSource();
    const engine = new GeolocationRecordingEngine({
      source: src.source,
      setWaypoints: () => pushes.push(1),
    });
    engines.push(engine);
    await engine.start({ waypoints: [wp("A", 43.03)] });
    const takeoff: SourcePosition[] = [];
    for (let i = 0; i < 3; i++) takeoff.push(position({ speed: 0 }));
    takeoff.push(position({ speed: 2 }));
    takeoff.push(position({ speed: 3 }));
    for (let i = 0; i < 5; i++) takeoff.push(position({ speed: 6 }));
    src.push(takeoff);
    const before = pushes.length;
    // One batch: cross into A, then a fix 20 min later (a stale gap).
    src.push([
      position({ latitude: 43.03, speed: 6 }),
      position({ latitude: 43.03, speed: 6 }, 20 * 60 * 1000),
    ]);
    const snap = engine.snapshotSync();
    expect(snap.status).toBe("ended");
    expect(snap.waypointsCursor).toBe(1); // reach counted despite the gap
    expect(snap.track.some((f) => f.latitude === 43.03)).toBe(true); // kept
    expect(pushes.length).toBe(before); // ended -> the reach push is suppressed
  });

  // N23 — dismissLanding while the watch is still alive re-feeds nothing
  // (ensureWatch early-returns on a live watch): no extra setWaypoints push.
  it("dismissLanding while landed pushes no waypoints and returns to recording", async () => {
    const pushes: number[] = [];
    const engine = new GeolocationRecordingEngine({
      source: navigatorPositionSource,
      setWaypoints: () => pushes.push(1),
    });
    engines.push(engine);
    await armAndTakeOff(engine, { waypoints: [wp("a", 43.03)] });
    for (let i = 0; i < LANDING_SUSTAIN_FIXES; i++) {
      geolocation.emit(position({ speed: 0.3 })); // stationary at 43.0, far from a
    }
    expect(engine.snapshotSync().status).toBe("landed");
    const before = pushes.length;
    engine.dismissLanding();
    expect(engine.snapshotSync().status).toBe("recording");
    expect(pushes.length).toBe(before); // no re-feed
  });

  // N24 — reach is ungated on takeoff so the engine mirrors the always-on
  // announcer. A waypoint crossed while still acquiring/armed is already
  // passed once airborne — it never re-surfaces. A future "gate reach on
  // takeoff" refactor (which would desync the announcer) must fail here.
  it("a waypoint crossed before takeoff is already passed once airborne", async () => {
    const engine = createEngine();
    await engine.start({ waypoints: [wp("a", 43.03)] });
    geolocation.emit(position({ latitude: 43.0, speed: 0 })); // arm a outside
    geolocation.emit(position({ latitude: 43.03, speed: 0 })); // cross a, pre-takeoff
    expect(engine.snapshotSync().status).not.toBe("recording");
    geolocation.emit(position({ latitude: 43.03, speed: 0 }));
    geolocation.emit(position({ latitude: 43.03, speed: 2 }));
    geolocation.emit(position({ latitude: 43.03, speed: 3 }));
    for (let i = 0; i < 5; i++) {
      geolocation.emit(position({ latitude: 43.03, speed: 6 })); // dwell + take off
    }
    const snap = engine.snapshotSync();
    expect(snap.status).toBe("recording");
    expect(snap.nextWaypoint).toBeNull(); // a passed pre-takeoff, not re-armed
    expect(snap.activeWaypoints).toEqual([]);
    expect(snap.waypointsCursor).toBe(1);
  });

  // N25 — the ended-guard makes both mutators inert once the flight of record
  // is final: no cursor/queue change, no push, no session write.
  it("mutations after end() are inert", async () => {
    const pushes: number[] = [];
    const engine = new GeolocationRecordingEngine({
      source: navigatorPositionSource,
      setWaypoints: () => pushes.push(1),
    });
    engines.push(engine);
    await armAndTakeOff(engine, {
      waypoints: [wp("a", 43.03), wp("b", 43.06)],
    });
    engine.end();
    expect(engine.snapshotSync().status).toBe("ended");
    const before = pushes.length;
    await engine.removeWaypoint("a"); // guarded: inert
    await engine.addAdhocWaypoint([-89.4, 43.05]); // guarded: inert
    const snap = engine.snapshotSync();
    expect(snap.waypointsCursor).toBe(0); // unchanged
    expect(snap.adhocWaypoints).toEqual([]); // add ignored
    expect(snap.nextWaypoint).toBeNull(); // ended
    expect(pushes.length).toBe(before); // no push from either mutator
  });
});
