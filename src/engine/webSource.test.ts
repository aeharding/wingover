import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IMPRECISE_SUSTAIN_MS } from "../flight/takeoff";
import type { SourceError, SourcePosition } from "./real";
import { createNavigatorSource } from "./webSource";

// The wall-clock behaviour the browser needs and no other platform does,
// tested where it now lives (#160). The engine-level versions of the latch
// cases moved here with it; what the engine still owns — a good fix
// lifting the takeover, storage not masking it — stays in real.test.ts.

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
    for (const watcher of [...this.watchers.values()])
      watcher.success(position);
  }

  emitError(code: number) {
    const error = {
      code,
      message: "stubbed",
      PERMISSION_DENIED: 1,
      POSITION_UNAVAILABLE: 2,
      TIMEOUT: 3,
    } as GeolocationPositionError;
    for (const watcher of [...this.watchers.values()]) watcher.error?.(error);
  }

  get watcherCount() {
    return this.watchers.size;
  }
}

let geolocation: FakeGeolocation;
let timestamp: number;

function position(
  overrides: Partial<GeolocationCoordinates> = {},
): GeolocationPosition {
  timestamp += 1000;
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

// Kilometer-coarse with no altitude solution: the reduced-accuracy
// signature (flight/takeoff.ts).
const reduced = () =>
  position({ accuracy: 13_000, altitude: null, altitudeAccuracy: null });

// Records everything one watch reports, so a test can assert on silence.
function startWatch() {
  const source = createNavigatorSource();
  const positions: SourcePosition[][] = [];
  const reports: (SourceError | null)[] = [];
  const stop = source.watch(
    (batch) => positions.push(batch),
    (refusal) => reports.push(refusal),
  );
  return { source, positions, reports, stop };
}

beforeEach(() => {
  geolocation = new FakeGeolocation();
  Object.defineProperty(globalThis, "navigator", {
    value: { geolocation },
    configurable: true,
    writable: true,
  });
  timestamp = 1_700_000_000_000;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the reduced-accuracy latch", () => {
  it("latches imprecise from a LONE reduced fix after the sustain window", async () => {
    // One kilometer-coarse, altitude-less fix, then silence — the
    // grid-pinned source shape that a count-based check never catches.
    const { reports } = startWatch();
    geolocation.emit(reduced());
    expect(reports).toEqual([]);

    await vi.advanceTimersByTimeAsync(IMPRECISE_SUSTAIN_MS + 1);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ imprecise: true });
  });

  it("a non-reduced fix disarms it", async () => {
    const { reports } = startWatch();
    geolocation.emit(reduced());
    await vi.advanceTimersByTimeAsync(IMPRECISE_SUSTAIN_MS / 2);
    geolocation.emit(position());
    await vi.advanceTimersByTimeAsync(IMPRECISE_SUSTAIN_MS * 2);
    expect(reports).toEqual([]);
  });

  // A fix that passes the accuracy gate is how the engine reaches "armed",
  // and an armed session must not be diagnosed by fix signatures — that is
  // the acquiring-only gate the latch used to read off engine status, now
  // stated in terms the source can see for itself.
  it("never arms again once a good fix has been delivered", async () => {
    const { reports } = startWatch();
    geolocation.emit(position());
    geolocation.emit(reduced());
    await vi.advanceTimersByTimeAsync(IMPRECISE_SUSTAIN_MS * 3);
    expect(reports).toEqual([]);
  });

  // Repeating a diagnosis the engine has already published changes
  // nothing, so one watch reports it once.
  it("reports the diagnosis once per watch", async () => {
    const { reports } = startWatch();
    geolocation.emit(reduced());
    await vi.advanceTimersByTimeAsync(IMPRECISE_SUSTAIN_MS + 1);
    geolocation.emit(reduced());
    geolocation.emit(reduced());
    await vi.advanceTimersByTimeAsync(IMPRECISE_SUSTAIN_MS * 3);
    expect(reports).toHaveLength(1);
  });

  // A watch torn down mid-window must not report into a channel the engine
  // has already replaced: the timer outliving its watch is exactly the
  // stale answer the old recovery loop had to guard against.
  it("a torn-down watch never fires its latch", async () => {
    const { reports, stop } = startWatch();
    geolocation.emit(reduced());
    stop();
    await vi.advanceTimersByTimeAsync(IMPRECISE_SUSTAIN_MS * 3);
    expect(reports).toEqual([]);
  });

  it("delivers every fix regardless of what the latch decides", () => {
    const { positions } = startWatch();
    geolocation.emit(reduced());
    geolocation.emit(position());
    expect(positions.flat()).toHaveLength(2);
  });
});

describe("revive", () => {
  // Safari kills a watch with no callback while the page is backgrounded
  // (a Settings trip is exactly that), and a browser cannot be asked
  // whether a watch would succeed. Reporting null is the ask: the engine
  // bounces, and the fresh watch either delivers or refuses.
  it("reports null so the engine bounces the watch", () => {
    const { source, reports } = startWatch();
    source.revive?.();
    expect(reports).toEqual([null]);
  });

  it("says nothing with no watch running", () => {
    const source = createNavigatorSource();
    const reports: (SourceError | null)[] = [];
    const stop = source.watch(
      () => {},
      (refusal) => reports.push(refusal),
    );
    stop();
    source.revive?.();
    expect(reports).toEqual([]);
    expect(geolocation.watcherCount).toBe(0);
  });

  it("speaks through the newest watch, never a torn-down one", () => {
    const source = createNavigatorSource();
    const first: (SourceError | null)[] = [];
    const second: (SourceError | null)[] = [];
    const stopFirst = source.watch(
      () => {},
      (refusal) => first.push(refusal),
    );
    source.watch(
      () => {},
      (refusal) => second.push(refusal),
    );
    // The engine bounces by tearing the old watch down after the new one
    // is up; the stale teardown must not take the channel with it.
    stopFirst();
    source.revive?.();
    expect(first).toEqual([]);
    expect(second).toEqual([null]);
  });
});

describe("the watch itself", () => {
  it("reports a permission denial as one, and other failures as neither", () => {
    const { reports } = startWatch();
    geolocation.emitError(1);
    geolocation.emitError(2);
    expect(reports).toEqual([
      { permissionDenied: true, message: "stubbed" },
      { permissionDenied: false, message: "stubbed" },
    ]);
  });

  it("refuses when the browser has no geolocation at all", () => {
    Object.defineProperty(globalThis, "navigator", {
      value: {},
      configurable: true,
      writable: true,
    });
    const reports: (SourceError | null)[] = [];
    createNavigatorSource().watch(
      () => {},
      (refusal) => reports.push(refusal),
    );
    expect(reports).toEqual([
      { permissionDenied: false, message: "no geolocation support" },
    ]);
  });
});
