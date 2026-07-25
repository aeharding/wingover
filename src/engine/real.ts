import {
  isLanded,
  LANDING_GRACE_MS,
  LANDING_SUSTAIN_FIXES,
} from "../flight/landing";
import { bearingBetween } from "../flight/nav";
import { haversineMeters } from "../flight/stats";
import {
  coordsLookReduced,
  detectTakeoff,
  fixLooksReduced,
  gpsReadyIndex,
  IMPRECISE_SUSTAIN_MS,
} from "../flight/takeoff";
import { WAYPOINT_RADIUS_M } from "../flight/waypoints";
import { mirrorSaysInPlay, setSessionInPlay } from "./sessionMirror";
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
import { isBlockingError } from "./types";
import type { BlockingError } from "./types";
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

const RECOVERY_POLL_MS = 2000;

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
  // iOS Precise Location off (native source only).
  imprecise?: boolean;
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
  // The source detects reduced accuracy itself via a real platform API
  // (CoreLocation's accuracyAuthorization); the engine must never guess
  // from fix signatures when this is set.
  reportsAccuracyAuthorization?: boolean;
  // The platform can kill an active watch without any callback (Safari
  // while backgrounded), so a foreground heal should bounce it. Sources
  // whose capture survives the page's visibility must never be bounced
  // by a mere foreground.
  watchCanDieSilently?: boolean;
  // Authoritative, side-effect-free "would a watch succeed right now?"
  // (native: permissions + Precise Location). While blocked on a
  // permission-class error, the engine polls this and retries the
  // moment it turns true — the hands-free recovery path on platforms
  // whose watch refusal is queryable. Absent = recovery relies on the
  // foreground heal / Try Again.
  readiness?: () => Promise<boolean>;
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
  watchCanDieSilently: true,
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
  // The WAL read rejected. Terminal: the hydration promise is memoized, so
  // it never retries this page. Recorded so the boot mirror stops being
  // consulted — an unreadable WAL is not evidence of a flight, and a
  // consumer must not be pinned to a flight surface that can never fill in.
  private hydrationFailed = false;
  private error: EngineError | null = null;
  private listeners = new Set<() => void>();
  private snapshotCache: EngineSnapshot | null = null;
  private notifyQueued = false;
  // Doubles as the "this engine owns the recorder" flag.
  private releaseRecorderLock: (() => void) | null = null;
  private walOwner = false;

  constructor(
    private readonly core: CoreClient = {
      source: navigatorPositionSource,
      setWaypoints: () => {},
    },
  ) {
    // Self-wired so recovery polling tracks blocked state through EVERY
    // invalidation path, without each error setter remembering it.
    this.subscribe(() => this.syncRecoveryPoll());
  }

  // While blocked on a permission-class error and the source can answer
  // "would a watch succeed now?", poll it and bounce the watch the moment
  // it says yes — the pilot flips the switch in Settings and the app
  // simply proceeds (covers iPad Split View, where no foreground ever
  // fires). This asks the platform instead of guessing, so it is the
  // WHOLE recovery path for sources whose capture outlives the page:
  // retry() (the web foreground/manual heal) is inert on them by design.
  private recoveryPoll: ReturnType<typeof setInterval> | null = null;
  // Bumped on every arm and disarm. A readiness() answer is in flight
  // across an unbounded round trip to the platform, so by the time it
  // lands the block it was asked about may be long over; the epoch it
  // captured at arm is how it proves it still speaks for the CURRENT one.
  private pollEpoch = 0;
  // A readiness-driven bounce whose fresh watch has not yet proven itself
  // by delivering a fix. Set at the attempt; NOT cleared by the bounce's
  // own optimistic error clear, so a blocking error landing again is read
  // as the same episode (the attempt failed) rather than a new one.
  private recoveryAttempted = false;

  private syncRecoveryPoll() {
    const readiness = this.core.source.readiness;
    const blocking = this.blockingError();
    const wants =
      readiness !== undefined && blocking !== null && blocking.code !== "busy";
    if (wants && this.recoveryPoll === null) {
      const epoch = ++this.pollEpoch;
      const check = () => {
        void readiness()
          .then((ready) => {
            // A stale answer is silent. Two ways to be stale: it belongs
            // to a previous arming (epoch), or the block it was asked
            // about healed while it was in flight (blockingError). Acting
            // on either tears down a LIVE watch on evidence about a state
            // that no longer exists.
            if (!ready || epoch !== this.pollEpoch) return;
            if (this.blockingError() === null) return;
            this.recoveryAttempted = true;
            this.bounceWatch();
          })
          // A readiness that rejects is simply not ready; the interval
          // asks again. It must not spam unhandled rejections at 0.5 Hz.
          .catch(() => {});
      };
      this.recoveryPoll = setInterval(check, RECOVERY_POLL_MS);
      // First check at arm, not one interval from now: where this poll is
      // the only recovery path, an interval of phase is an interval of
      // stale takeover on screen (a block armed on a rebuilt webview
      // after a Settings trip is exactly that).
      //
      // Only on the FIRST arming of an episode, though. Readiness and the
      // watch's pre-capture refusal are meant to be one rule (native:
      // nativeSource's permissionRefusal, which also folds Location
      // Services off into a denial), so a platform that answers ready
      // while its watch keeps refusing is a contradiction — but the
      // engine must stay bounded even against one. A re-arm inside the
      // same episode means the last attempt failed, so it waits for the
      // interval. Invariant, against ANY source behaviour: at most one
      // recovery attempt per RECOVERY_POLL_MS, and a takeover that holds
      // steady between attempts instead of flickering through acquiring.
      if (!this.recoveryAttempted) check();
    } else if (!wants && this.recoveryPoll !== null) {
      clearInterval(this.recoveryPoll);
      this.recoveryPoll = null;
      this.pollEpoch++;
    }
  }

  // Two engines on one WAL (two PWA tabs) would interleave duplicate fixes
  // into the same store — an unexplainable corrupt flight later. A Web
  // Lock makes the recorder exclusive per origin; where the API is absent
  // (tests, ancient webviews) recording proceeds unguarded, as before.
  private async acquireRecorderLock(): Promise<boolean> {
    const acquired = await this.acquireRecorderLockInner();
    // Ownership is what licenses WAL destruction (discard): a tab that
    // was refused the lock must never clear the owning tab's flight.
    // Lock-less environments (tests, ancient webviews) proceed as owner,
    // exactly as they record unguarded.
    if (acquired) this.walOwner = true;
    return acquired;
  }

  private acquireRecorderLockInner(): Promise<boolean> {
    if (this.releaseRecorderLock) return Promise.resolve(true);
    const locks =
      typeof navigator === "undefined" ? undefined : navigator.locks;
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
      const { session, fixes } = await readWal().catch((error: unknown) => {
        // Not swallowed — an unreadable WAL is a real failure and the caller
        // still hears it — but the engine must not go silent either: nothing
        // else will ever notify, and a consumer waiting on the boot mirror
        // would sit on a surface that can never fill in. The mirror in
        // STORAGE is left exactly as it was: a read that failed proves
        // nothing about what the WAL holds, and the next launch reads again.
        this.hydrationFailed = true;
        this.invalidate();
        throw error;
      });
      // start()/stop() may have won while the read was in flight; their
      // in-memory state is newer than anything the WAL held.
      if (!this.hydrated) {
        this.hydrated = true;
        this.session = session;
        this.buffer = fixes;
        // The WAL has spoken: reconcile the boot mirror against it, here at
        // the top of hydration, before anything below can await and let a
        // render read a stale answer. This is the direction that makes the
        // mirror safe to trust at first render — a session recovered after a
        // crash sets it (this sitting never ran start()), and a flag left
        // over from a flight this WAL no longer holds clears it, so an idle
        // app settles into the shell instead of sitting on a flight surface
        // forever.
        setSessionInPlay(session !== null);
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
          } else if (session.takeoffIndex === null) {
            // Pre-takeoff: the busy takeover owns the surface. A flight
            // already in progress instead keeps this tab as a passive
            // read-only viewer — a blocking screen must never hide a
            // flight, and this is a SETTER of the pre-takeoff-only
            // blocking invariant.
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

  // The single predicate behind the "blocked" discriminant: deriveStatus
  // and deriveSnapshot both consult it, so the type-level promise that
  // blocked always carries a BlockingError is enforced at one site.
  // No takeoff check here: a blocking error cannot exist once a flight
  // has started, and that invariant lives at the SETTERS —
  // handleWatchError refuses to install one mid-flight, the imprecise
  // latch requires "acquiring", and busy arises only from start() and
  // from pre-takeoff hydration adoption (mid-flight adoption stays a
  // viewer). Pre-takeoff blocked absorbs (imprecise excepted — it
  // self-heals), so a flight can never begin with one still set.
  private blockingError(): BlockingError | null {
    return this.error !== null && isBlockingError(this.error)
      ? this.error
      : null;
  }

  // The one thing a consumer may trust at FIRST render, before the WAL read
  // has resolved. In memory the answer is simply whether a session exists;
  // pre-hydration there is nothing in memory yet, so it comes from the boot
  // mirror instead (sessionMirror.ts). The mirror is consulted in exactly
  // that window: once the WAL has spoken — or refused to — memory is the
  // only answer, so a stale flag self-corrects and an unreadable WAL cannot
  // pin the UI to a flight it will never produce.
  private sessionInPlay(): boolean {
    if (this.session !== null) return true;
    if (this.hydrated || this.hydrationFailed) return false;
    return mirrorSaysInPlay();
  }

  private deriveSnapshot(): EngineSnapshot {
    const session = this.session;
    const error = this.error;
    const blocking = this.blockingError();
    if (blocking) {
      // Blocked is strictly pre-takeoff, so there is never a track to
      // preserve here.
      const nav = session ? this.navState() : null;
      return {
        status: "blocked",
        error: blocking,
        sessionInPlay: this.sessionInPlay(),
        startedAt: null,
        track: [],
        latest: this.buffer[this.buffer.length - 1] ?? null,
        landingAt: null,
        waypoints: session?.waypoints ?? [],
        adhocWaypoints: nav?.adhocActive ?? [],
        waypointsCursor: nav?.waypointsCursor ?? 0,
        // No live nav while blocked — and activeWaypoints[0] must always
        // BE nextWaypoint (types.ts contract), so both go empty together.
        nextWaypoint: null,
        activeWaypoints: [],
        autoEnd: session?.autoEnd !== false,
      };
    }
    if (!session) {
      return {
        status: "idle",
        sessionInPlay: this.sessionInPlay(),
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
    const status = this.activityStatus();
    const latest = this.buffer[this.buffer.length - 1] ?? null;
    const waypoints = session.waypoints ?? [];
    const autoEnd = session.autoEnd !== false;
    const nav = this.navState();
    if (status === "ended") {
      const track = this.finalizedTrack();
      return {
        status,
        sessionInPlay: this.sessionInPlay(),
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
        sessionInPlay: this.sessionInPlay(),
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
      sessionInPlay: this.sessionInPlay(),
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
    // A session exists from this instant, so the boot mirror says so from
    // this instant: a webview death one beat after Start must relaunch onto
    // the flight surface, not the homescreen (sessionMirror.ts).
    setSessionInPlay(true);
    this.buffer = [];
    this.reachInside.clear();
    this.reachedIds.clear();
    this.error = null;
    this.recoveryAttempted = false;
    // A latch armed by a previous session must not fire into this one.
    this.clearImpreciseTimer();
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

  // The sanctioned exit from "blocked" besides discard()/start(): clear
  // the blocking error and restart the watch with the session intact, so
  // the UI recovers straight back into acquiring — never through idle
  // (the homepage must not flash behind the error screen). Both recovery
  // mechanisms land here, so the guards live at this single mutation
  // site: busy is excluded (another holder owns the recorder lock, and a
  // new watch here would not contest it), and post-takeoff is a no-op (a
  // started flight's source is never touched).
  private bounceWatch(): void {
    if (!this.session || this.session.takeoffIndex !== null) return;
    if (this.error?.code === "busy") return;
    // A storage error rides through the bounce: it is not the watch's
    // problem, and only a successful write may clear it.
    if (this.error !== null && this.error.code !== "storage") this.error = null;
    this.clearWatch();
    this.ensureWatch();
    this.invalidate();
  }

  // The WEB heal, and only the web's: the foreground handler
  // (engine/session.ts) and the error screen's Try Again both arrive
  // here. A browser watch can be killed silently while the page is
  // backgrounded (a Settings trip is exactly that), leaving acquiring
  // frozen on the last pre-trip fix with no error to show for it, and a
  // browser cannot be asked whether a watch would succeed — so bouncing
  // is the only way to find out. Bouncing a healthy one costs nothing
  // there: a fresh watch gets an immediate delivery.
  //
  // Sources whose capture outlives the page opt out of BOTH cases,
  // healthy and blocked: their recorder must never be touched by a mere
  // foreground, and they recover through the readiness poll above, which
  // asks the platform instead of guessing. Capability, not platform —
  // the engine never switches on where it is running.
  retry(): void {
    if (!this.core.source.watchCanDieSilently) return;
    this.bounceWatch();
  }

  async discard(): Promise<void> {
    this.clearWatch();
    this.hydrated = true;
    this.session = null;
    // Gated exactly like the clearWal below, and for the same reason: the
    // mirror caches the WAL, localStorage is origin-wide like the WAL, and
    // only the owner may retire either. A passive tab (busy) clearing this
    // would send the OWNING tab's next launch to the homescreen. Otherwise
    // synchronous, with the session itself and ahead of the invalidate: the
    // mirror may lag the WAL toward "in play", never toward idle.
    if (this.walOwner) setSessionInPlay(false);
    this.buffer = [];
    this.reachInside.clear();
    this.reachedIds.clear();
    this.error = null;
    this.recoveryAttempted = false;
    this.invalidate();
    await this.walQueue;
    // Only the WAL's owner may destroy it: a passive tab (busy) clearing
    // it would wipe the owning tab's flight and skew the indices its
    // later session writes journal.
    if (this.walOwner) await clearWal();
    // Orphans from a storage outage must not leak into the next session.
    this.pendingWalFixes = [];
    if (this.releaseRecorderLock) {
      this.releaseRecorderLock();
      this.walOwner = false;
    }
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

  // "blocked" is a live-source overlay: derived from the in-memory
  // error, never journaled, strictly pre-takeoff. Everything beneath it
  // derives purely from WAL data (see activityStatus).
  private deriveStatus(): EngineStatus {
    // A blocking error owns the surface: the watch is dead or the
    // recorder is held elsewhere, and nothing proceeds until the pilot
    // acts (or a retry clears it). A journaled stop still wins — a
    // finalized flight must reach collection regardless.
    if (this.blockingError()) return "blocked";
    return this.activityStatus();
  }

  // What the engine is doing, blocking errors aside. Pure derivation
  // from WAL data — no transient flags: a rehydration or burst replay
  // lands in exactly the same state as live delivery would. The narrow
  // return type is what lets deriveSnapshot build the non-blocked
  // snapshot variants without a cast.
  private activityStatus(): Exclude<EngineStatus, "blocked"> {
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
    // Once the flight starts, we're going: no source error may
    // transition a started flight toward "blocked" (or any error state).
    // Whatever fixes still arrive get consumed; a permanently dead
    // source ends the flight through the stale-gap path, never through
    // an error screen.
    if (this.session && this.session.takeoffIndex !== null) return;
    this.error = error.imprecise
      ? {
          code: "imprecise",
          message: "Precise Location is off for Wingover.",
        }
      : error.permissionDenied
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
    this.clearImpreciseTimer();
    if (this.stopWatch !== null) {
      this.stopWatch();
      this.stopWatch = null;
    }
  }

  // Wall-clock latch for the reduced-accuracy signature: armed by the
  // first reduced fix while acquiring, disarmed by any non-reduced fix
  // (or the watch going away). If it survives the sustain window and the
  // latest fix still looks reduced, Precise Location is off.
  private impreciseTimer: ReturnType<typeof setTimeout> | null = null;

  private armImpreciseTimer() {
    if (this.impreciseTimer !== null) return;
    this.impreciseTimer = setTimeout(() => {
      this.impreciseTimer = null;
      const latest = this.buffer[this.buffer.length - 1];
      // Note a pending storage error cannot mask this: storage is not a
      // blocking code, so status is still "acquiring" through it (a
      // Settings trip severs IndexedDB in WKWebView — exactly when this
      // latch is about to matter).
      if (
        this.deriveStatus() === "acquiring" &&
        latest &&
        fixLooksReduced(latest)
      ) {
        this.error = {
          code: "imprecise",
          message:
            "Kilometer-coarse fixes with no altitude; Precise Location is likely off.",
        };
        this.invalidate();
      }
    }, IMPRECISE_SUSTAIN_MS);
  }

  private clearImpreciseTimer() {
    if (this.impreciseTimer !== null) {
      clearTimeout(this.impreciseTimer);
      this.impreciseTimer = null;
    }
  }

  // Batch ingest, the TS twin of core.rs's ingest(&[Fix]). Detection runs
  // per fix — landing/takeoff indices must land exactly where live
  // delivery would have put them (fix-time doctrine) — but the batch is
  // one state change: one WAL flush joins the queue, one invalidation.
  private handlePositions(positions: SourcePosition[]) {
    if (!this.session) return;
    // "blocked" absorbs for the authoritative dead-ends: busy (another
    // holder owns the recorder) and permission-denied (the watch is
    // dead). imprecise is a DIAGNOSIS — disproven by a single good fix
    // (Precise flipped back on, or the heuristic was wrong) — so it
    // self-heals instead of holding the screen against the evidence,
    // while a still-coarse stream keeps absorbing (no flap). Status-
    // gated, not error-gated: mid-flight these codes never block, and
    // ingest must keep running.
    const blocking = this.blockingError();
    if (blocking !== null) {
      if (blocking.code !== "imprecise") return;
      if (!positions.some((p) => !coordsLookReduced(p.coords))) return;
      this.error = null;
    }
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
    // A delivered fix is the only proof a recovery attempt actually
    // worked, so it is the only thing that ends the episode: the next
    // block gets its immediate check back.
    this.recoveryAttempted = false;
    // Heuristic net for sources that CANNOT self-report reduced
    // accuracy (the web Geolocation API offers no way to ask): without
    // it, Precise Location off hangs acquiring forever with no
    // explanation. Sources with the real API (native CoreLocation)
    // report through the error channel instead and never guess.
    // Wall-clock latched, because a grid-pinned coarse source may
    // deliver ONE fix then go silent — a count of arrivals would never
    // accumulate. Self-healing: any non-reduced fix disarms the latch.
    const latestFix = this.buffer[this.buffer.length - 1];
    if (
      !this.core.source.reportsAccuracyAuthorization &&
      this.deriveStatus() === "acquiring" &&
      latestFix &&
      fixLooksReduced(latestFix)
    ) {
      this.armImpreciseTimer();
    } else {
      this.clearImpreciseTimer();
    }
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
        // A pilot-actionable takeover outranks the storage diagnostic —
        // never tear one down. The failed batch is retained either way
        // and retries on the next write.
        if (this.error !== null && isBlockingError(this.error)) return;
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
