import { createNanoEvents } from "nanoevents";

import {
  isLanded,
  LANDING_GRACE_MS,
  LANDING_SUSTAIN_FIXES,
} from "../flight/landing";
import { bearingBetween } from "../flight/nav";
import { haversineMeters } from "../flight/stats";
import { detectTakeoff, gpsReadyIndex } from "../flight/takeoff";
import type {
  EngineError,
  EngineEvents,
  EngineSnapshot,
  EngineStatus,
  Fix,
  RecordingEngine,
  StartOptions,
  Waypoint,
} from "./types";
import {
  appendWalFixes,
  clearWal,
  readWal,
  type WalSession,
  writeWalSession,
} from "./wal";

// Thresholds in takeoff.ts are tuned for ~1 Hz fixes; platforms can burst
// duplicates far faster (PPG Flyer exports contain 44 ms doubles).
const MIN_FIX_INTERVAL_MS = 500;
const DERIVE_COURSE_MIN_SPEED_MPS = 0.5;

export interface SourcePosition {
  timestamp: number;
  coords: {
    latitude: number;
    longitude: number;
    accuracy: number;
    altitude: number | null;
    altitudeAccuracy: number | null;
    speed: number | null;
    heading: number | null;
  };
}

export interface SourceError {
  permissionDenied: boolean;
  message: string;
}

export interface WatchOptions {
  // Timestamp of the newest fix already held (WAL-rehydrated); sources
  // that buffer natively replay everything after it. Browser sources
  // have no backlog and ignore it.
  since?: number;
}

// Seam between the recording engine and wherever fixes come from:
// navigator.geolocation in the browser, the wingover plugin
// (CoreLocation + native queue) in the native apps.
export interface PositionSource {
  watch(
    onPosition: (position: SourcePosition) => void,
    onError: (error: SourceError) => void,
    options?: WatchOptions,
  ): () => void;
}

// The plugin surface as the engine sees it, identical on every platform:
// the watch carries the core lifecycle (start_watch/stop_watch native,
// webCore's wrapper on the web); setWaypoints mirrors the
// set_waypoints command — config pushes only.
export interface CoreClient {
  source: PositionSource;
  setWaypoints(waypoints: Waypoint[]): void;
}

export const navigatorPositionSource: PositionSource = {
  watch(onPosition, onError) {
    if (!("geolocation" in navigator)) {
      onError({ permissionDenied: false, message: "no geolocation support" });
      return () => {};
    }
    const id = navigator.geolocation.watchPosition(
      (position) => onPosition(position),
      (error) =>
        onError({
          permissionDenied: error.code === error.PERMISSION_DENIED,
          message: error.message,
        }),
      { enableHighAccuracy: true, maximumAge: 0 },
    );
    return () => navigator.geolocation.clearWatch(id);
  },
};

export class GeolocationRecordingEngine implements RecordingEngine {
  private events = createNanoEvents<EngineEvents>();
  private buffer: Fix[] = [];
  private session: WalSession | null = null;
  private stopWatch: (() => void) | null = null;
  private lastStatus: EngineStatus = "idle";
  private walQueue: Promise<unknown> = Promise.resolve();
  private pendingWalFixes: Fix[] = [];
  private hydrated = false;
  private hydration: Promise<void> | null = null;

  constructor(
    private readonly core: CoreClient = {
      source: navigatorPositionSource,
      setWaypoints: () => {},
    },
  ) {}

  // The WAL is a crash log, not a live source of truth: it hydrates memory
  // exactly once (page load / webview rebirth). After that, a WAL read can
  // only be equal or STALE — queued writes, or a read racing a replay
  // burst — so re-applying one would tear live fixes out of the buffer and
  // revert the session (the "straight line after waking mid-flight" bug).
  private ensureHydrated(): Promise<void> {
    if (this.hydrated) return Promise.resolve();
    this.hydration ??= (async () => {
      const { session, fixes } = await readWal();
      // start()/stop() may have won while the read was in flight; their
      // in-memory state is newer than anything the WAL held.
      if (!this.hydrated) {
        this.hydrated = true;
        this.session = session;
        this.buffer = fixes;
      }
    })();
    return this.hydration;
  }

  async getSnapshot(): Promise<EngineSnapshot> {
    await this.ensureHydrated();
    // Drain pending WAL writes: a snapshot taken here reports state the
    // log has already made at least as durable. Fixes landing during the
    // await only make the memory-derived snapshot fresher — never stale.
    await this.walQueue;
    return this.snapshotSync();
  }

  // Pure synchronous view of in-memory state. Engine event listeners must
  // use this instead of awaiting getSnapshot(): a replay burst delivers
  // many fixes in one task, so anything applied across an await is already
  // stale by the time the continuation runs.
  snapshotSync(): EngineSnapshot {
    const session = this.session;
    if (!session) {
      return {
        status: "idle",
        startedAt: null,
        track: [],
        landingAt: null,
        waypoints: [],
      };
    }
    const status = this.deriveStatus();
    this.lastStatus = status;
    if (status === "ended") {
      // Final flight waiting to be collected; the watch stays off.
      const track = this.finalizedTrack();
      return {
        status,
        startedAt: track[0]?.timestamp ?? null,
        track,
        landingAt: this.landingAt(),
        waypoints: session.waypoints ?? [],
      };
    }
    this.ensureWatch();
    if (status !== "recording" && status !== "landed") {
      return {
        status,
        startedAt: null,
        track: [],
        landingAt: null,
        waypoints: session.waypoints ?? [],
      };
    }
    const track = this.buffer.slice(session.takeoffIndex!);
    return {
      status,
      startedAt: track[0]?.timestamp ?? null,
      track,
      landingAt: this.landingAt(),
      waypoints: session.waypoints ?? [],
    };
  }

  get status(): EngineStatus {
    return this.lastStatus;
  }

  private landingAt(): number | null {
    const index = this.session?.landingIndex;
    return index != null ? (this.buffer[index]?.timestamp ?? null) : null;
  }

  async start(options?: StartOptions): Promise<void> {
    await clearWal();
    // The fresh session IS the state now; a hydration read still in
    // flight must not apply over it.
    this.hydrated = true;
    this.session = {
      armedAt: Date.now(),
      takeoffIndex: null,
      waypoints: options?.waypoints ?? [],
    };
    this.buffer = [];
    await writeWalSession(this.session);
    this.setStatus("acquiring");
    this.ensureWatch();
  }

  // Mid-flight additions join this flight only; the plan is untouched.
  async addWaypoints(waypoints: Waypoint[]): Promise<void> {
    if (!this.session || waypoints.length === 0) return;
    this.session = {
      ...this.session,
      waypoints: [...(this.session.waypoints ?? []), ...waypoints],
    };
    const session = this.session;
    this.enqueueWal(() => writeWalSession(session));
    this.core.setWaypoints(session.waypoints ?? []);
    await this.walQueue;
  }

  async stop(): Promise<Fix[]> {
    const track = this.finalizedTrack();
    this.clearWatch();
    this.hydrated = true;
    this.session = null;
    this.buffer = [];
    await this.walQueue;
    await clearWal();
    this.setStatus("idle");
    return track;
  }

  on<E extends keyof EngineEvents>(
    event: E,
    listener: EngineEvents[E],
  ): () => void {
    return this.events.on(event, listener);
  }

  dismissLanding(): void {
    if (!this.session || this.session.landingIndex == null) return;
    this.session = {
      ...this.session,
      landingIndex: null,
      landingDismissed: true,
    };
    const session = this.session;
    this.enqueueWal(() => writeWalSession(session));
    this.setStatus(this.deriveStatus());
  }

  // The flight of record ends at touchdown: everything after the detected
  // landing fix is stationary tail and is discarded.
  private finalizedTrack(): Fix[] {
    const session = this.session;
    if (!session || session.takeoffIndex === null) return [];
    const end =
      session.landingIndex != null
        ? session.landingIndex + 1
        : this.buffer.length;
    return this.buffer.slice(session.takeoffIndex, end);
  }

  // Pure derivation from WAL data — no transient flags. A rehydration or
  // burst replay lands in exactly the same state as live delivery would.
  private deriveStatus(): EngineStatus {
    if (!this.session) return "idle";
    if (this.session.takeoffIndex === null) {
      return gpsReadyIndex(this.buffer) !== null ? "armed" : "acquiring";
    }
    const landingIndex = this.session.landingIndex;
    if (landingIndex == null) return "recording";
    const touchdown = this.buffer[landingIndex];
    const latest = this.buffer[this.buffer.length - 1];
    if (
      touchdown &&
      latest &&
      latest.timestamp - touchdown.timestamp >= LANDING_GRACE_MS
    ) {
      return "ended";
    }
    return "landed";
  }

  private setStatus(status: EngineStatus) {
    if (status === this.lastStatus) return;
    this.lastStatus = status;
    this.events.emit("status", status);
  }

  private ensureWatch() {
    if (this.stopWatch !== null) return;
    const latest = this.buffer[this.buffer.length - 1];
    this.stopWatch = this.core.source.watch(
      (position) => this.handlePosition(position),
      (error) => this.handleWatchError(error),
      { since: latest?.timestamp },
    );
    // Config follows the watch: initial start and post-reload rehydration
    // both re-push the session's set here (native: harmless overwrite of
    // what waypoints.json already hydrated).
    this.core.setWaypoints(this.session?.waypoints ?? []);
  }

  private handleWatchError(error: SourceError) {
    console.warn("geolocation error:", error.message);
    if (error.permissionDenied) {
      this.emitError({
        code: "permission-denied",
        message:
          "Location permission denied. Allow location access for Wingover, then try again.",
      });
    } else {
      this.emitError({
        code: "unavailable",
        message: "GPS unavailable — check that location services are on.",
      });
    }
  }

  private emitError(error: EngineError) {
    this.events.emit("error", error);
  }

  private clearWatch() {
    if (this.stopWatch !== null) {
      this.stopWatch();
      this.stopWatch = null;
    }
  }

  private handlePosition(position: SourcePosition) {
    if (!this.session) return;
    const previous = this.buffer[this.buffer.length - 1];
    if (
      previous &&
      position.timestamp - previous.timestamp < MIN_FIX_INTERVAL_MS
    ) {
      return;
    }
    const fix = this.toFix(position, previous);
    this.buffer.push(fix);
    // Fixes accumulate until the queued flush runs, so a burst becomes a
    // few large transactions instead of thousands of small ones.
    this.pendingWalFixes.push(fix);
    if (this.pendingWalFixes.length === 1) {
      this.enqueueWal(() => {
        const batch = this.pendingWalFixes;
        this.pendingWalFixes = [];
        return appendWalFixes(batch);
      });
    }

    this.events.emit("fix", fix);

    if (this.session.takeoffIndex === null) {
      const takeoffIndex = detectTakeoff(this.buffer);
      if (takeoffIndex !== null) {
        this.session = { ...this.session, takeoffIndex };
        const session = this.session;
        this.enqueueWal(() => writeWalSession(session));
      }
    } else {
      this.detectLanding();
    }
    const status = this.deriveStatus();
    // The flight of record is final: stop consuming. The WAL is retained
    // until the consumer collects via stop().
    if (status === "ended") this.clearWatch();
    this.setStatus(status);
  }

  // All in fix time, never wall clock: a landing sitting in a replayed
  // backlog detects and finalizes exactly as it would have live. The
  // resulting state is fully derived (deriveStatus), so this only maintains
  // the landing marker in the session.
  private detectLanding() {
    const session = this.session;
    if (!session || session.takeoffIndex === null) return;

    const windowStart = Math.max(
      session.takeoffIndex,
      this.buffer.length - LANDING_SUSTAIN_FIXES,
    );
    const landedNow = isLanded(this.buffer.slice(windowStart));

    if (!landedNow) {
      if (session.landingIndex != null || session.landingDismissed) {
        this.session = {
          ...session,
          landingIndex: null,
          landingDismissed: false,
        };
        const updated = this.session;
        this.enqueueWal(() => writeWalSession(updated));
      }
      return;
    }

    if (session.landingDismissed || session.landingIndex != null) return;

    const landingIndex = this.buffer.length - LANDING_SUSTAIN_FIXES;
    this.session = { ...session, landingIndex };
    const updated = this.session;
    this.enqueueWal(() => writeWalSession(updated));
  }

  private enqueueWal(operation: () => Promise<void>) {
    this.walQueue = this.walQueue.then(operation).catch((error) => {
      console.error("wal write failed:", error);
    });
  }

  private toFix(position: SourcePosition, previous: Fix | undefined): Fix {
    const coords = position.coords;
    const timestamp = position.timestamp;
    const seconds = previous ? (timestamp - previous.timestamp) / 1000 : 0;
    const here = { latitude: coords.latitude, longitude: coords.longitude };

    const altitude = coords.altitude ?? previous?.altitude ?? 0;

    let speed = coords.speed;
    if (speed === null || Number.isNaN(speed)) {
      speed =
        previous && seconds > 0 ? haversineMeters(previous, here) / seconds : 0;
    }

    let course = coords.heading;
    if (course === null || Number.isNaN(course)) {
      course =
        previous && speed >= DERIVE_COURSE_MIN_SPEED_MPS
          ? bearingBetween(previous, here)
          : (previous?.course ?? 0);
    }

    const climbRate =
      previous && seconds > 0 && coords.altitude !== null
        ? (altitude - previous.altitude) / seconds
        : 0;

    return {
      timestamp,
      latitude: coords.latitude,
      longitude: coords.longitude,
      altitude,
      speed,
      course,
      climbRate,
      horizontalAccuracy: coords.accuracy,
      // Strict: without a vertical accuracy the gate must not pass. Real
      // devices (Core Location) always provide it; desktop wifi fixes don't
      // and shouldn't record flights.
      verticalAccuracy: coords.altitudeAccuracy ?? Number.POSITIVE_INFINITY,
    };
  }
}
