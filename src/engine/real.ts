import {
  isLanded,
  LANDING_GRACE_MS,
  LANDING_SUSTAIN_FIXES,
} from "../flight/landing";
import { bearingBetween } from "../flight/nav";
import { haversineMeters } from "../flight/stats";
import { detectTakeoff, gpsReadyIndex } from "../flight/takeoff";
import { WAYPOINT_RADIUS_M } from "../flight/waypoints";
import type {
  EngineError,
  EngineSnapshot,
  EngineStatus,
  Fix,
  LngLat,
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
// A gap this long between two consecutive fixes means nothing recorded in
// between — the app was gone (phone died, force-quit, evicted) while the
// native background capture was NOT running. The flight ended at the fix
// before the gap; the fix after it belongs to a different sitting. A gap
// shorter than this is just GPS jitter or a brief outage and is kept.
// Evaluated on the fix stream (after any backlog replays), never on wall
// clock at hydration: the native queue can hold minutes of valid fixes
// that must replay before we judge the flight over.
const STALE_FLIGHT_MS = 15 * 60 * 1000;

const STORAGE_ERROR: EngineError = {
  code: "storage",
  message:
    "Storage writes are failing. This flight is not being saved. Keep the app open.",
};

const BUSY_ERROR: EngineError = {
  code: "busy",
  message: "Recording is already running in another tab.",
};

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
// (CoreLocation + native queue) in the native apps. Fixes arrive in
// BATCHES, mirroring the Rust core's ingest(&[Fix]): a backlog replay is
// one call, making the burst boundary structural instead of an accident
// of delivery timing; live browser cadence is simply a batch of one.
export interface PositionSource {
  watch(
    onPositions: (positions: SourcePosition[]) => void,
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
  watch(onPositions, onError) {
    if (!("geolocation" in navigator)) {
      onError({ permissionDenied: false, message: "no geolocation support" });
      return () => {};
    }
    const id = navigator.geolocation.watchPosition(
      (position) => onPositions([position]),
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
  private buffer: Fix[] = [];
  private session: WalSession | null = null;
  private stopWatch: (() => void) | null = null;
  private walQueue: Promise<unknown> = Promise.resolve();
  private pendingWalFixes: Fix[] = [];
  private walFlushQueued = false;
  // Derived nav state — a cache of a pure function of (buffer × planned ×
  // ad-hoc). Rebuilt from the buffer on hydration (rebuildReachState); never
  // journaled, so a lost session write self-heals from the durable fix stream
  // exactly like takeoffIndex/landingIndex. reachInside = per-waypoint arm
  // state (outside/inside); reachedIds = the set that has crossed inside.
  private reachInside = new Map<string, boolean>();
  private reachedIds = new Set<string>();
  private hydrated = false;
  private hydration: Promise<void> | null = null;
  private error: EngineError | null = null;
  private listeners = new Set<() => void>();
  private snapshotCache: EngineSnapshot | null = null;
  private notifyQueued = false;
  // Doubles as the "this engine owns the recorder" flag.
  private releaseRecorderLock: (() => void) | null = null;

  constructor(
    private readonly core: CoreClient = {
      source: navigatorPositionSource,
      setWaypoints: () => {},
    },
  ) {}

  // Two engines on one WAL (two PWA tabs) would interleave duplicate fixes
  // into the same store — an unexplainable corrupt flight later. A Web
  // Lock makes the recorder exclusive per origin; where the API is absent
  // (tests, ancient webviews) recording proceeds unguarded, as before.
  private acquireRecorderLock(): Promise<boolean> {
    if (this.releaseRecorderLock) return Promise.resolve(true);
    const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
    if (!locks) return Promise.resolve(true);
    return new Promise((resolve) => {
      locks
        .request("wingover-recorder", { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve(false);
            return;
          }
          resolve(true);
          // Held until released: the lock lives as long as this promise.
          return new Promise<void>((release) => {
            this.releaseRecorderLock = () => {
              this.releaseRecorderLock = null;
              release();
            };
          });
        })
        // A locks API failure must not block recording.
        .catch(() => resolve(true));
    });
  }

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
        // Derive reached state from the durable buffer BEFORE deriveStatus /
        // ensureWatch, so the fed remaining set excludes already-passed
        // waypoints (no re-arm, no re-announce on re-entry).
        this.rebuildReachState();
        // Rehydrating a live session restarts capture; a finalized flight
        // ("ended") stays parked until collected via stop(). If another
        // tab owns the recorder, this one stays a passive viewer.
        //
        // A flight the app was gone from is NOT ended here: the native
        // source keeps recording in the background, so what looks like a
        // stale last fix is usually just a backlog waiting to replay. The
        // end is detected on the fix stream instead (a >= STALE_FLIGHT_MS
        // gap between consecutive fixes; see handlePositions), so the
        // backlog replays first and only a genuine gap finalizes.
        if (session && this.deriveStatus() !== "ended") {
          if (await this.acquireRecorderLock()) {
            this.ensureWatch();
          } else {
            this.error = BUSY_ERROR;
          }
        }
        this.invalidate();
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

  // Every state change funnels through here: drop the cached snapshot and
  // schedule ONE notification per task. A replay burst delivers thousands
  // of fixes synchronously; subscribers wake once, after it, and read a
  // complete, consistent view — there is no per-fix delta stream to fall
  // behind on.
  private invalidate() {
    this.snapshotCache = null;
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    queueMicrotask(() => {
      this.notifyQueued = false;
      for (const listener of [...this.listeners]) listener();
    });
  }

  // Stable identities (class fields, not methods): useSyncExternalStore
  // resubscribes when the subscribe function changes and compares
  // snapshots by identity, so both must survive being passed around bare.
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  // Pure cached view of in-memory state: the same object until something
  // changes, a fresh derivation after. Reads have no side effects — safe
  // to call during React render.
  snapshotSync = (): EngineSnapshot => {
    this.snapshotCache ??= this.deriveSnapshot();
    return this.snapshotCache;
  };

  private deriveSnapshot(): EngineSnapshot {
    const session = this.session;
    const error = this.error;
    if (!session) {
      return {
        status: "idle",
        startedAt: null,
        track: [],
        latest: null,
        landingAt: null,
        waypoints: [],
        adhocWaypoints: [],
        waypointsCursor: 0,
        nextWaypoint: null,
        activeWaypoints: [],
        autoEnd: true,
        error,
      };
    }
    const status = this.deriveStatus();
    const latest = this.buffer[this.buffer.length - 1] ?? null;
    const waypoints = session.waypoints ?? [];
    const autoEnd = session.autoEnd !== false;
    const nav = this.navState();
    if (status === "ended") {
      const track = this.finalizedTrack();
      return {
        status,
        startedAt: track[0]?.timestamp ?? null,
        track,
        latest,
        landingAt: this.landingAt(),
        waypoints,
        adhocWaypoints: nav.adhocActive,
        waypointsCursor: nav.waypointsCursor,
        // A finalized flight surfaces no live nav target.
        nextWaypoint: null,
        activeWaypoints: [],
        autoEnd,
        error,
      };
    }
    if (status !== "recording" && status !== "landed") {
      return {
        status,
        startedAt: null,
        track: [],
        latest,
        landingAt: null,
        waypoints,
        adhocWaypoints: nav.adhocActive,
        waypointsCursor: nav.waypointsCursor,
        nextWaypoint: nav.nextWaypoint,
        activeWaypoints: nav.active,
        autoEnd,
        error,
      };
    }
    const track = this.buffer.slice(session.takeoffIndex!);
    return {
      status,
      startedAt: track[0]?.timestamp ?? null,
      track,
      latest,
      landingAt: this.landingAt(),
      waypoints,
      adhocWaypoints: nav.adhocActive,
      waypointsCursor: nav.waypointsCursor,
      nextWaypoint: nav.nextWaypoint,
      activeWaypoints: nav.active,
      autoEnd,
      error,
    };
  }

  private landingAt(): number | null {
    const index = this.session?.landingIndex;
    return index != null ? (this.buffer[index]?.timestamp ?? null) : null;
  }

  async start(options?: StartOptions): Promise<void> {
    // The lock comes first: without it this tab must not touch the WAL
    // (clearing it would destroy the owning tab's flight).
    if (!(await this.acquireRecorderLock())) {
      this.error = BUSY_ERROR;
      this.invalidate();
      return;
    }
    await clearWal();
    // The fresh session IS the state now; a hydration read still in
    // flight must not apply over it.
    this.hydrated = true;
    this.pendingWalFixes = [];
    this.session = {
      armedAt: Date.now(),
      takeoffIndex: null,
      waypoints: options?.waypoints ?? [],
      autoEnd: options?.autoEnd ?? true,
    };
    this.buffer = [];
    this.reachInside.clear();
    this.reachedIds.clear();
    this.error = null;
    await writeWalSession(this.session);
    this.ensureWatch();
    this.invalidate();
  }

  // Long-press mid-flight: append an ad-hoc nav target (FIFO, drained ahead
  // of the plan). at = [longitude, latitude]. Membership is journaled; the
  // insertion anchor keeps a point long-pressed AFTER it was overflown from
  // counting as instantly reached. Joins this flight only; plan untouched.
  async addAdhocWaypoint(at: LngLat): Promise<void> {
    // Ignore once the flight of record is final (a stray long-press on the
    // frozen landed map must not mutate a done flight). Pre-takeoff marking
    // (acquiring/armed) stays legitimate.
    if (!this.session || this.deriveStatus() === "ended") return;
    const [longitude, latitude] = at;
    const adhoc = {
      id: crypto.randomUUID(),
      latitude,
      longitude,
      radiusM: WAYPOINT_RADIUS_M,
      addedAtIndex: this.buffer.length,
    };
    this.session = {
      ...this.session,
      adhocWaypoints: [...(this.session.adhocWaypoints ?? []), adhoc],
    };
    const session = this.session;
    this.enqueueWal(() => writeWalSession(session));
    this.core.setWaypoints(this.activeWaypoints());
    this.invalidate();
    await this.walQueue;
  }

  // Remove a specific active waypoint by id: journal its id so it is skipped,
  // silently. No-op if the id is not currently active (already passed, already
  // removed, or unknown) — no write, no push.
  async removeWaypoint(id: string): Promise<void> {
    if (!this.session || this.deriveStatus() === "ended") return;
    if (!this.activeWaypoints().some((w) => w.id === id)) return;
    this.session = {
      ...this.session,
      removedIds: [...(this.session.removedIds ?? []), id],
    };
    const session = this.session;
    this.enqueueWal(() => writeWalSession(session));
    this.core.setWaypoints(this.activeWaypoints());
    this.invalidate();
    await this.walQueue;
  }

  // Derived nav — a pure function of (session × reachedIds), no side effects.
  // active = active ad-hoc (FIFO) ++ active planned; a waypoint is active iff
  // it is neither reached (derived) nor removed (journaled).
  private navState(): {
    active: Waypoint[];
    adhocActive: Waypoint[];
    nextWaypoint: Waypoint | null;
    waypointsCursor: number;
  } {
    const s = this.session;
    if (!s)
      return {
        active: [],
        adhocActive: [],
        nextWaypoint: null,
        waypointsCursor: 0,
      };
    const removed = new Set(s.removedIds ?? []);
    const isActive = (w: Waypoint) =>
      !this.reachedIds.has(w.id) && !removed.has(w.id);
    const adhocActive = (s.adhocWaypoints ?? [])
      .filter(isActive)
      // Drop the internal addedAtIndex anchor from the public Waypoint shape.
      .map((w): Waypoint => ({
        id: w.id,
        latitude: w.latitude,
        longitude: w.longitude,
        radiusM: w.radiusM,
      }));
    const planned = s.waypoints ?? [];
    const plannedActive = planned.filter(isActive);
    let waypointsCursor = 0;
    while (
      waypointsCursor < planned.length &&
      !isActive(planned[waypointsCursor])
    ) {
      waypointsCursor++;
    }
    const active = [...adhocActive, ...plannedActive];
    return {
      active,
      adhocActive,
      nextWaypoint: active[0] ?? null,
      waypointsCursor,
    };
  }

  private activeWaypoints(): Waypoint[] {
    return this.navState().active;
  }

  // Reach detection — a faithful mirror of flight/waypoints.ts `ingest`
  // (arm-silently on the first fix; reach ONLY on an outside→inside
  // transition), so the derived reached set is in lockstep with what the
  // tracker/announcer speaks on the same fed set. It records the reached id
  // instead of the "Waypoint reached" string (we cannot observe the tracker:
  // on web it lives inside WebCore, on device it is a separate Rust process).
  // Runs on the de-noised buffer (post MIN_FIX_INTERVAL); a genuine
  // outside→inside→outside crossing inside a <500 ms window would need
  // >1.28 km/s at this radius, so the filter never hides a real crossing.
  // Returns true if any waypoint newly reached on this fix.
  private updateReach(index: number, fix: Fix): boolean {
    const s = this.session;
    if (!s) return false;
    const removed = new Set(s.removedIds ?? []);
    const targets: Waypoint[] = [];
    for (const w of s.adhocWaypoints ?? []) {
      if (
        w.addedAtIndex <= index &&
        !this.reachedIds.has(w.id) &&
        !removed.has(w.id)
      ) {
        targets.push(w);
      }
    }
    for (const w of s.waypoints ?? []) {
      if (!this.reachedIds.has(w.id) && !removed.has(w.id)) targets.push(w);
    }
    let reached = false;
    for (const w of targets) {
      const nowInside = haversineMeters(fix, w) <= w.radiusM;
      const prev = this.reachInside.get(w.id);
      if (prev === undefined) {
        this.reachInside.set(w.id, nowInside); // first fix arms, silent
      } else if (!prev && nowInside) {
        this.reachInside.set(w.id, true);
        this.reachedIds.add(w.id); // outside → inside = reached
        reached = true;
      } else if (prev && !nowInside) {
        this.reachInside.set(w.id, false);
      }
    }
    return reached;
  }

  // Recompute the derived reach state from scratch over the durable buffer —
  // called on hydration so a lost session write self-heals from the fixes.
  private rebuildReachState() {
    this.reachInside.clear();
    this.reachedIds.clear();
    for (let i = 0; i < this.buffer.length; i++) {
      this.updateReach(i, this.buffer[i]);
    }
  }

  async discard(): Promise<void> {
    this.clearWatch();
    this.hydrated = true;
    this.session = null;
    this.buffer = [];
    this.reachInside.clear();
    this.reachedIds.clear();
    this.error = null;
    this.invalidate();
    await this.walQueue;
    await clearWal();
    // Orphans from a storage outage must not leak into the next session.
    this.pendingWalFixes = [];
    this.releaseRecorderLock?.();
  }

  // The durable manual stop: journal the intent, derive "ended", and let
  // the ordinary collection path (persist first, clear after) finish the
  // job. The old shape — clear the WAL, then persist the returned track —
  // had a crash window in which the flight existed nowhere.
  end(): void {
    const session = this.session;
    if (!session || session.takeoffIndex === null || session.stoppedAt != null)
      return;
    this.session = { ...session, stoppedAt: Date.now() };
    const updated = this.session;
    this.enqueueWal(() => writeWalSession(updated));
    // The flight of record is final: stop consuming, like a detected end.
    this.clearWatch();
    this.invalidate();
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
    // Grace may already have expired ("ended" cleared the watch a beat
    // before the tap landed): recording resumes, so the watch must too.
    this.ensureWatch();
    this.invalidate();
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
    // A journaled manual stop finalizes exactly like an expired grace.
    if (this.session.stoppedAt != null) return "ended";
    const landingIndex = this.session.landingIndex;
    if (landingIndex == null) return "recording";
    const touchdown = this.buffer[landingIndex];
    const latest = this.buffer[this.buffer.length - 1];
    if (
      touchdown &&
      latest &&
      latest.timestamp - touchdown.timestamp >= LANDING_GRACE_MS &&
      // The pilot opted out of auto-finalization: the flight stays
      // "landed" (prompting) until they decide.
      this.session.autoEnd !== false
    ) {
      return "ended";
    }
    return "landed";
  }

  private ensureWatch() {
    if (this.stopWatch !== null) return;
    const latest = this.buffer[this.buffer.length - 1];
    this.stopWatch = this.core.source.watch(
      (positions) => this.handlePositions(positions),
      (error) => this.handleWatchError(error),
      { since: latest?.timestamp },
    );
    // Config follows the watch: initial start and post-reload rehydration
    // both re-push the ACTIVE remaining set here (planned-past-cursor + active
    // ad-hoc). A passed waypoint is excluded so it can't re-arm/re-announce.
    this.core.setWaypoints(this.activeWaypoints());
  }

  private handleWatchError(error: SourceError) {
    console.warn("geolocation error:", error.message);
    this.error = error.permissionDenied
      ? {
          code: "permission-denied",
          message:
            "Location permission denied. Allow location access for Wingover, then try again.",
        }
      : {
          code: "unavailable",
          message: "GPS unavailable. Check that location services are on.",
        };
    this.invalidate();
  }

  private clearWatch() {
    if (this.stopWatch !== null) {
      this.stopWatch();
      this.stopWatch = null;
    }
  }

  // Batch ingest, the TS twin of core.rs's ingest(&[Fix]). Detection runs
  // per fix — landing/takeoff indices must land exactly where live
  // delivery would have put them (fix-time doctrine) — but the batch is
  // one state change: one WAL flush joins the queue, one invalidation.
  private handlePositions(positions: SourcePosition[]) {
    if (!this.session) return;
    let ingested = false;
    let reachedChanged = false;
    for (const position of positions) {
      const previous = this.buffer[this.buffer.length - 1];
      if (
        previous &&
        position.timestamp - previous.timestamp < MIN_FIX_INTERVAL_MS
      ) {
        continue;
      }
      // A long gap to the next fix means the app was gone (phone died /
      // evicted) with nothing recording. The active flight ended at
      // `previous`; this fix and any after it are a separate sitting, so
      // finalize here and stop consuming. Runs on the fix stream, so a
      // replayed native backlog (continuous fixes, no gap) never trips it —
      // only a genuine break does.
      if (
        previous &&
        this.session.takeoffIndex !== null &&
        this.session.stoppedAt == null &&
        position.timestamp - previous.timestamp >= STALE_FLIGHT_MS
      ) {
        this.session = { ...this.session, stoppedAt: previous.timestamp };
        const ended = this.session;
        this.enqueueWal(() => writeWalSession(ended));
        ingested = true;
        break;
      }
      const fix = this.toFix(position, previous);
      this.buffer.push(fix);
      // Fixes accumulate until the queued flush runs, so a burst becomes a
      // few large transactions instead of thousands of small ones.
      this.pendingWalFixes.push(fix);
      this.queueWalFlush();

      // Reach detection runs on every ingested fix (ungated on takeoff —
      // matches the announcer, which ingests from start()) and is purely
      // derived, so it emits NO session write. Set-based: one fix can reach
      // several waypoints (overlapping radii / a backlog fly-through).
      if (this.updateReach(this.buffer.length - 1, fix)) reachedChanged = true;

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
      ingested = true;
    }
    if (!ingested) return;
    // Fixes flowing again means GPS has recovered; a storage error is a
    // different channel — only a successful write clears it.
    if (this.error?.code !== "storage") this.error = null;
    // The flight of record is final: stop consuming. The WAL is retained
    // until the consumer persists the flight and calls discard().
    if (this.deriveStatus() === "ended") this.clearWatch();
    // One coalesced config push per batch: re-feed the shrunk active set so
    // the announcer drops just-reached waypoints. After the tracker has
    // already spoken this batch (core.ingest runs before onPositions), so the
    // re-feed cannot race the announcement.
    if (reachedChanged && this.deriveStatus() !== "ended") {
      this.core.setWaypoints(this.activeWaypoints());
    }
    this.invalidate();
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

  // The engine's whole pitch is durability, so a failing WAL write is not
  // a log line — it surfaces as snapshot.error (on the PWA the WAL is the
  // ONLY durable copy). GPS errors clear on the next fix; a storage error
  // clears only when a write actually succeeds again.
  private enqueueWal(operation: () => Promise<void>) {
    this.walQueue = this.walQueue.then(operation).then(
      () => {
        if (this.error?.code !== "storage") return;
        this.error = null;
        this.invalidate();
      },
      (error) => {
        console.error("wal write failed:", error);
        if (this.error?.code === "storage") return;
        this.error = STORAGE_ERROR;
        this.invalidate();
      },
    );
  }

  // At most one flush waits in the queue; it drains everything pending
  // when it runs. On failure the batch is retained for the next attempt —
  // a storage outage must not eat fixes that could still land later.
  private queueWalFlush() {
    if (this.walFlushQueued || this.pendingWalFixes.length === 0) return;
    this.walFlushQueued = true;
    this.enqueueWal(async () => {
      this.walFlushQueued = false;
      const batch = this.pendingWalFixes;
      this.pendingWalFixes = [];
      try {
        await appendWalFixes(batch);
      } catch (error) {
        this.pendingWalFixes = [...batch, ...this.pendingWalFixes];
        throw error;
      }
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
