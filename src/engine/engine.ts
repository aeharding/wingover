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
  gpsReadyIndex,
  takeoffAt,
} from "../flight/takeoff";
import { WAYPOINT_RADIUS_M } from "../flight/waypoints";
import type {
  EngineError,
  RecordingEngine as EngineImpl,
  EngineSnapshot,
  EngineStatus,
  Fix,
  HydrationState,
  LngLat,
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
  // Precise Location off: CoreLocation's accuracyAuthorization natively,
  // the reduced-fix latch in the browser.
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
  // onRefusal carries what stands RIGHT NOW: a refusal, or null for
  // "nothing refuses any more". Both are reports about the same thing, so
  // both travel one channel; the engine acts on the latest (see
  // handleRefusal). Every source is responsible for knowing its own
  // refusals by its platform's means — the native one asks CoreLocation,
  // the browser one experiments — and the engine never guesses.
  watch(
    onPositions: (positions: SourcePosition[]) => void,
    onRefusal: (refusal: SourceError | null) => void,
    options?: WatchOptions,
  ): () => void;
  // "Find out whether you still refuse, and report it." Called on every
  // foreground and by the error screen's Try Again. null here means
  // "bounce me", so a source whose capture outlives the page must send it
  // only when it has a refusal to clear: a bounce stops that capture.
  // Absent = a foreground tells this source nothing it does not know.
  revive?(): void;
}

// The one mapping from what the source refused with to what the pilot is
// told: the same refusal cannot render as two different screens depending
// on which path carried it (the watch's own report, or a revive
// answering).
function toEngineError(error: SourceError): EngineError {
  if (error.imprecise) {
    return {
      code: "imprecise",
      message: "Precise Location is off for Wingover.",
    };
  }
  if (error.permissionDenied) {
    return {
      code: "permission-denied",
      message:
        "Location permission denied. Allow location access for Wingover, then try again.",
    };
  }
  return {
    code: "unavailable",
    message: "GPS unavailable. Check that location services are on.",
  };
}

// The plugin surface as the engine sees it, identical on every platform:
// the watch carries the core lifecycle (start_watch/stop_watch native,
// webCore's wrapper on the web); setWaypoints mirrors the
// set_waypoints command — config pushes only.
export interface CoreClient {
  source: PositionSource;
  setWaypoints(waypoints: Waypoint[]): void;
}

export class Engine implements EngineImpl {
  private buffer: Fix[] = [];
  private session: WalSession | null = null;
  private stopWatch: (() => void) | null = null;
  private walQueue: Promise<unknown> = Promise.resolve();
  private pendingWalFixes: Fix[] = [];
  private walFlushQueued = false;
  // Derived nav state — a cache of a pure function of (buffer × planned ×
  // ad-hoc), rebuilt from the buffer on hydration (rebuildReachState) and
  // never journaled, so no session write can lose it. takeoffIndex has the
  // same twin (rebuildTakeoff). landingIndex does NOT yet: it is journaled
  // only, so a lost write leaves markLanding to re-anchor it from the
  // trailing window. landingDismissed is a third class — journaled pilot
  // intent, not derivable from fixes: losing its write revives the prompt
  // on rehydration, which the pilot (present for the tap seconds earlier)
  // re-answers. reachInside = per-waypoint arm state (outside/inside);
  // reachedIds = the set that has crossed inside.
  private reachInside = new Map<string, boolean>();
  private reachedIds = new Set<string>();
  private hydrated = false;
  private hydration: Promise<void> | null = null;
  private hydrationState: HydrationState = "pending";
  private error: EngineError | null = null;
  private listeners = new Set<() => void>();
  private snapshotCache: EngineSnapshot | null = null;
  private notifyQueued = false;
  // Doubles as the "this engine owns the recorder" flag.
  private releaseRecorderLock: (() => void) | null = null;
  private walOwner = false;
  // The last discard()'s destructive tail. start() gates on it: the UI
  // shows idle (Start tappable) while the tail is still draining, and a
  // start entering under it would have its fresh WAL cleared and its
  // fresh lock released by the old session's teardown.
  private teardown: Promise<void> = Promise.resolve();
  private lockRequest: Promise<boolean> | null = null;
  private startInFlight: Promise<void> | null = null;

  constructor(private readonly core: CoreClient) {}

  // Two engines on one WAL (two PWA tabs) would interleave duplicate fixes
  // into the same store — an unexplainable corrupt flight later. A Web
  // Lock makes the recorder exclusive per origin; where the API is absent
  // (tests, ancient webviews) recording proceeds unguarded, as before.
  // Ownership (walOwner) is what licenses WAL destruction (discard): a
  // tab that was refused the lock must never clear the owning tab's
  // flight. Lock-less environments (tests, ancient webviews) proceed as
  // owner, exactly as they record unguarded. Every grant sets walOwner in
  // the same task it installs the release — a discard capturing between
  // the two would otherwise release a lock whose ownership it never saw.
  private acquireRecorderLock(): Promise<boolean> {
    if (this.releaseRecorderLock) {
      this.walOwner = true;
      return Promise.resolve(true);
    }
    const locks =
      typeof navigator === "undefined" ? undefined : navigator.locks;
    if (!locks) {
      this.walOwner = true;
      return Promise.resolve(true);
    }
    // One request at a time: the API never grants synchronously, so two
    // concurrent starts (a double tap aligned by the teardown gate) would
    // otherwise race two ifAvailable requests — and the second refusal
    // would publish a false "recording somewhere else" takeover from the
    // tab that IS the recorder.
    this.lockRequest ??= new Promise<boolean>((resolve) => {
      locks
        .request("wingover-recorder", { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve(false);
            return;
          }
          // Held until released: the lock lives as long as this promise.
          // The self-null is guarded because a discard captures this
          // closure and may invoke it after a fresh session has installed
          // its own — the old release must not strip the new field.
          const held = new Promise<void>((release) => {
            const releaseLock = () => {
              if (this.releaseRecorderLock === releaseLock) {
                this.releaseRecorderLock = null;
              }
              release();
            };
            this.releaseRecorderLock = releaseLock;
          });
          this.walOwner = true;
          resolve(true);
          return held;
        })
        // A locks API failure must not block recording.
        .catch(() => {
          this.walOwner = true;
          resolve(true);
        });
    }).finally(() => {
      this.lockRequest = null;
    });
    return this.lockRequest;
  }

  // The boot gate reads this like any other engine fact. "failed" means
  // the WAL could not be read at all: the UI must show a way out (reload),
  // never an idle screen — Start Flight would clear the WAL that the
  // failed read proves we cannot see.
  readonly hydrationSync = (): HydrationState => this.hydrationState;

  // The WAL is a crash log, not a live source of truth: it hydrates memory
  // exactly once (page load / webview rebirth). After that, a WAL read can
  // only be equal or STALE — queued writes, or a read racing a replay
  // burst — so re-applying one would tear live fixes out of the buffer and
  // revert the session (the "straight line after waking mid-flight" bug).
  private ensureHydrated(): Promise<void> {
    if (this.hydrated) return Promise.resolve();
    this.hydration ??= this.hydrate();
    return this.hydration;
  }

  private async hydrate(): Promise<void> {
    try {
      await this.adoptWal();
      this.hydrationState = "ready";
    } catch (error) {
      console.error("wal read failed:", error);
      this.hydrationState = "failed";
    }
    this.invalidate();
  }

  private async adoptWal(): Promise<void> {
    const { session, fixes } = await readWal();
    // start()/stop() may have won while the read was in flight; their
    // in-memory state is newer than anything the WAL held.
    if (this.hydrated) return;
    this.hydrated = true;
    this.session = session;
    this.buffer = fixes;
    // Derive reached state from the durable buffer BEFORE deriveStatus /
    // ensureWatch, so the fed remaining set excludes already-passed
    // waypoints (no re-arm, no re-announce on re-entry).
    this.rebuildReachState();
    this.rebuildTakeoff();
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
    if (!session) return;
    // A finalized flight parks: there is no watch to restart. It still needs
    // the LOCK, though, because collection is about to consume it and only the
    // owner may clear the WAL (discard). Returning without it left walOwner
    // false, so the WAL survived collection and every later launch re-collected
    // the same flight — re-toasting, and resurrecting one the pilot had
    // deleted. A tab refused the lock still collects (the deterministic id
    // makes that a no-op) and correctly leaves the clearing to the owner.
    if (this.deriveStatus() === "ended") {
      await this.acquireRecorderLock();
      return;
    }
    if (await this.acquireRecorderLock()) {
      this.ensureWatch();
      // this.session, not the WAL's copy: rebuildTakeoff may have just
      // derived a takeoff the session write never recorded, and that IS a
      // flight in progress.
    } else if (this.session?.takeoffIndex == null) {
      // Pre-takeoff: the busy takeover owns the surface. A flight
      // already in progress instead keeps this tab as a passive
      // read-only viewer — a blocking screen must never hide a
      // flight, and this is a SETTER of the pre-takeoff-only
      // blocking invariant.
      this.error = BUSY_ERROR;
    }
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
  // handleRefusal refuses to install one mid-flight, and busy arises
  // only from start() and from pre-takeoff hydration adoption (mid-flight
  // adoption stays a viewer). Pre-takeoff blocked absorbs (imprecise
  // excepted — a good fix clears it), so a flight can never begin with one
  // still set.
  private blockingError(): BlockingError | null {
    return this.error !== null && isBlockingError(this.error)
      ? this.error
      : null;
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
        detectLanding: session?.detectLanding !== false,
      };
    }
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
        detectLanding: true,
        error,
      };
    }
    const status = this.activityStatus();
    const latest = this.buffer[this.buffer.length - 1] ?? null;
    const waypoints = session.waypoints ?? [];
    const detectLanding = session.detectLanding !== false;
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
        detectLanding,
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
        detectLanding,
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
      detectLanding,
      error,
    };
  }

  private landingAt(): number | null {
    const index = this.session?.landingIndex;
    return index != null ? (this.buffer[index]?.timestamp ?? null) : null;
  }

  // Single-flight: taps aligned by the teardown gate join the start
  // already in progress instead of each clearing and re-writing the WAL.
  // N racing starts are N chances for one transient storage failure to
  // strip a session another start just established, and same-frame taps
  // carry identical options, so joining loses nothing.
  start(options?: StartOptions): Promise<void> {
    this.startInFlight ??= this.startInner(options).finally(() => {
      this.startInFlight = null;
    });
    return this.startInFlight;
  }

  private async startInner(options?: StartOptions): Promise<void> {
    // A prior discard's tail may still be draining (see this.teardown).
    await this.teardown;
    // The lock comes first: without it this tab must not touch the WAL
    // (clearing it would destroy the owning tab's flight).
    const heldBefore = this.releaseRecorderLock !== null;
    if (!(await this.acquireRecorderLock())) {
      this.error = BUSY_ERROR;
      this.invalidate();
      return;
    }
    try {
      await clearWal();
    } catch (error) {
      // A tab that failed to start must not keep the recorder — an idle
      // tab holding the lock tells every other tab "recording somewhere
      // else" for the rest of its page life. But it may only give back
      // the grant THIS start took: releasing one a live session already
      // held would strip that session's only WAL protection. Surfaced
      // like any failed WAL write (see enqueueWal), not swallowed.
      this.error = STORAGE_ERROR;
      this.invalidate();
      if (!heldBefore && this.releaseRecorderLock) {
        this.releaseRecorderLock();
        this.walOwner = false;
      }
      throw error;
    }
    // The fresh session IS the state now; a hydration read still in
    // flight must not apply over it.
    this.hydrated = true;
    this.pendingWalFixes = [];
    this.session = {
      armedAt: Date.now(),
      takeoffIndex: null,
      waypoints: options?.waypoints ?? [],
      detectLanding: options?.detectLanding ?? true,
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
  // called on hydration so a lost session write is rebuilt from the fixes.
  private rebuildReachState() {
    this.reachInside.clear();
    this.reachedIds.clear();
    for (let i = 0; i < this.buffer.length; i++) {
      this.updateReach(i, this.buffer[i]);
    }
  }

  // Twin of rebuildReachState for takeoff: the durable buffer can hold a
  // launch the session still calls pre-takeoff, because fixes reach the
  // WAL before the session write that names their takeoff (queueWalFlush
  // is enqueued first) and a session write that fails is never retried.
  // Ingest asks takeoffAt only at the newest fix, so nothing else would
  // ever look inside a rehydrated prefix, and the flight would stay armed
  // until the next start() cleared it away. Derived in memory only: a
  // passive tab that lost the recorder lock must not write the owner's
  // WAL, and this is a pure function of fixes that already survived.
  // A journaled index can also outrun the fixes it points into: the fix
  // flush is enqueued before the session write and a failed batch is
  // retained for retry, not rethrown, so a crash can leave takeoffIndex
  // past the rehydrated buffer. Left alone it would sit inert until the
  // buffer grew back past it — and then anchor landing detection to an
  // arbitrary mid-flight fix. Out of range means the write it indexed is
  // gone: re-derive from the fixes that survived, like everything else.
  private rebuildTakeoff() {
    const session = this.session;
    if (!session) return;
    const journaled = session.takeoffIndex;
    if (journaled !== null && journaled < this.buffer.length) return;
    const takeoffIndex = detectTakeoff(this.buffer);
    if (takeoffIndex === journaled) return;
    this.session = { ...session, takeoffIndex };
  }

  // The sanctioned exit from "blocked" besides discard()/start(): clear
  // the blocking error and restart the watch with the session intact, so
  // the UI recovers straight back into acquiring — never through idle
  // (the homepage must not flash behind the error screen). Every bounce
  // lands here, so the guards live at this single mutation site: busy is
  // excluded (another holder owns the recorder lock, and a
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

  // The foreground handler (engine/session.ts) and the error screen's Try
  // Again both arrive here, and both mean the same thing: ask the source
  // to find out where it stands. What that costs is the source's own
  // business (ARCHITECTURE.md); whatever it finds comes back through
  // onRefusal like any other report. Capability, not platform: the engine
  // never switches on where it is running.
  retry(): void {
    this.core.source.revive?.();
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
    // Orphans from a storage outage must not leak into the next session —
    // cleared here, synchronously, because by the time the tail drains a
    // fresh session may be buffering fixes of its own.
    this.pendingWalFixes = [];
    // The tail may only destroy what this discard took from it: captured
    // here and handed over, because by the time the tail drains, the live
    // fields may belong to a fresh session the tail must not touch.
    const release = this.releaseRecorderLock;
    const owned = this.walOwner;
    this.releaseRecorderLock = null;
    this.walOwner = false;
    const teardown = this.teardownSession(release, owned);
    // The gate stores completion, not success (a clear lost to a storage
    // outage must not poison every future start() with a rejected gate),
    // and chains, so an overlapping discard cannot drop an earlier tail
    // out of the gate while it is still destructive.
    this.teardown = Promise.allSettled([this.teardown, teardown]).then(
      () => {},
    );
    await teardown;
  }

  // The destructive tail of discard(). The finally is load-bearing: a WAL
  // clear lost to a storage outage must not also leak the recorder lock,
  // or an idle tab tells every other tab "recording somewhere else" for
  // the rest of its page life. On the collection path the WAL itself is
  // safe to leave behind — the next boot re-collects it, and the
  // deterministic flight id makes that save a no-op. A cancelled armed
  // session left behind rehydrates instead; nothing is lost either way.
  private async teardownSession(
    release: (() => void) | null,
    owned: boolean,
  ): Promise<void> {
    try {
      await this.walQueue;
      // Only the WAL's owner may destroy it: a passive tab (busy) clearing
      // it would wipe the owning tab's flight and skew the indices its
      // later session writes journal.
      if (owned) await clearWal();
    } finally {
      release?.();
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
      // The pilot opted out of landing detection: the flight stays
      // "landed" (prompting) until they decide.
      this.session.detectLanding !== false
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
      (refusal) => this.handleRefusal(refusal),
      { since: latest?.timestamp },
    );
    // Config follows the watch: initial start and post-reload rehydration
    // both re-push the ACTIVE remaining set here (planned-past-cursor + active
    // ad-hoc). A passed waypoint is excluded so it can't re-arm/re-announce.
    this.core.setWaypoints(this.activeWaypoints());
  }

  // Every report the source makes about whether it can record arrives
  // here: its watch refusing, and a revive answering. One channel and one
  // set of rules, so the same refusal cannot render as two different
  // screens depending on which path carried it.
  private handleRefusal(refusal: SourceError | null) {
    // The source knows of no refusal. On one that can ask its platform
    // that is an answer; on one that cannot, it means "try a fresh watch
    // and find out". Either way the response is the same, and bounceWatch
    // holds the rules for when a bounce is legal.
    if (refusal === null) {
      this.bounceWatch();
      return;
    }
    console.warn("geolocation error:", refusal.message);
    // Once the flight starts, we're going: no report may transition a
    // started flight toward "blocked" (or any error state). Whatever
    // fixes still arrive get consumed; a permanently dead source ends the
    // flight through the stale-gap path, never through an error screen.
    if (this.session && this.session.takeoffIndex !== null) return;
    // busy is not the source's to replace: another tab holds the recorder
    // lock, and nothing a location source reports can change that.
    if (this.error?.code === "busy") return;
    const fresh = toEngineError(refusal);
    // A non-blocking report never replaces a takeover: it would drop the
    // screen to acquiring behind a watch that is still refused.
    if (this.blockingError() !== null && !isBlockingError(fresh)) return;
    // Already the reason on screen. Publishing it again would wake every
    // subscriber for as long as a source keeps repeating itself.
    if (fresh.code === this.error?.code) return;
    this.error = fresh;
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
    // "blocked" absorbs for the authoritative dead-ends: busy (another
    // holder owns the recorder) and permission-denied (the watch is
    // dead). imprecise is a DIAGNOSIS — disproven by a single good fix
    // (Precise flipped back on, or the heuristic was wrong) — so that fix
    // clears it instead of the screen standing against the evidence,
    // while a still-coarse stream keeps absorbing (no flap). Status-
    // gated, not error-gated: mid-flight these codes never block, and
    // ingest must keep running.
    const blocking = this.blockingError();
    let receivedGoodFix = false;
    if (blocking !== null) {
      if (blocking.code !== "imprecise") return;
      if (!positions.some((p) => !coordsLookReduced(p.coords))) return;
      this.error = null;
      receivedGoodFix = true;
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
        const takeoffIndex = takeoffAt(this.buffer, this.buffer.length - 1);
        if (takeoffIndex !== null) {
          this.session = { ...this.session, takeoffIndex };
          const session = this.session;
          this.enqueueWal(() => writeWalSession(session));
        }
      } else {
        this.markLanding();
        // Same rule as the stale-gap break above, reached the ordinary
        // way: the flight of record is over, so nothing after it belongs
        // to this session. Draining the rest of a backlog anyway costs
        // nothing visible but persists it — a day-long replay wrote 100k
        // fixes behind a 7k flight, and every later WAL read paid 3.4 s
        // for them. It also makes a burst land where live delivery would:
        // live, the fix that expires the grace clears the watch, so the
        // fixes after it were never recorded either.
        if (this.activityStatus() === "ended") {
          ingested = true;
          break;
        }
      }
      ingested = true;
    }
    if (!ingested) {
      // The good fix that cleared the takeover can still be dropped by
      // the duplicate filter below (a burst double, 44 ms apart). The
      // takeover is already cleared, so that has to be PUBLISHED: an
      // error cleared without an invalidation leaves the takeover on a
      // cached snapshot that is never rebuilt. On native that is a screen
      // with no way out but Cancel.
      if (receivedGoodFix) this.invalidate();
      return;
    }
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
  private markLanding() {
    const session = this.session;
    if (!session || session.takeoffIndex === null) return;
    // Flight-scoped pilot intent (wal.ts landingDismissed): never re-ask.
    if (session.landingDismissed) return;

    const launch = this.buffer[session.takeoffIndex];
    const windowStart = Math.max(
      session.takeoffIndex,
      this.buffer.length - LANDING_SUSTAIN_FIXES,
    );
    const landedNow =
      launch != null && isLanded(this.buffer.slice(windowStart), launch);

    if (!landedNow) {
      if (session.landingIndex != null) {
        this.session = { ...session, landingIndex: null };
        const updated = this.session;
        this.enqueueWal(() => writeWalSession(updated));
      }
      return;
    }

    if (session.landingIndex != null) return;

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
