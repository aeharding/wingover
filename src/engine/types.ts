export interface Fix {
  timestamp: number;
  latitude: number;
  longitude: number;
  altitude: number;
  speed: number;
  course: number;
  climbRate: number;
  horizontalAccuracy: number;
  verticalAccuracy: number;
}

// Flight lifecycle. "landed": touchdown detected, recording continues,
// pilot may dismiss. "ended": landing grace expired (fix time) OR the
// pilot's stop was journaled (end()) — the flight of record is final and
// waits durably in the WAL until the consumer persists it and calls
// discard(); a crash between finalization and persistence loses nothing.
// A flight's waypoint: an anonymous geofence (no name), copied from a
// plan pin at flight start (flight/session.ts). Owned by the session —
// never a live view of the plan.
export interface Waypoint {
  id: string;
  latitude: number;
  longitude: number;
  radiusM: number;
}

// [longitude, latitude] — the map/pin tuple order (structurally the same as
// src/ui/map's LngLat). Named order here to kill the lat/lng swap footgun.
export type LngLat = readonly [longitude: number, latitude: number];

export interface StartOptions {
  waypoints?: Waypoint[];
  // Grace expiry auto-finalizes the landed flight (default true). Copied
  // into the session: the active flight keeps the choice it started with.
  autoEnd?: boolean;
}

export type EngineStatus =
  "idle" | "acquiring" | "armed" | "recording" | "landed" | "ended";

export interface EngineSnapshot {
  status: EngineStatus;
  startedAt: number | null;
  // CONTRACT: within a session the track is append-only and prefix-stable
  // by timestamp — a new array identity per change, but content only ever
  // grows. Session boundaries (start/stop) reset it. Incremental consumers
  // (the live map) build on this.
  track: Fix[];
  // Newest fix of the session in any phase — populated while acquiring,
  // long before the track exists.
  latest: Fix | null;
  // Touchdown timestamp once landing is detected (pending finalization).
  landingAt: number | null;
  // Planned route waypoints (copied from Plan pins at takeoff), immutable.
  waypoints: Waypoint[];
  // Active (un-passed) ad-hoc nav queue, FIFO. Drained ahead of the plan.
  adhocWaypoints: Waypoint[];
  // Index of the next un-passed planned waypoint (= waypoints.length if done).
  waypointsCursor: number;
  // Current steer-to target: adhocActive[0] ?? plannedActive[0] ?? null.
  // null = nothing left → the UI navigates back to launch. null when ended.
  nextWaypoint: Waypoint | null;
  // The active nav sequence in steer-to order (active ad-hoc, then active
  // planned) — the numbered map markers, where index 0 is nextWaypoint.
  activeWaypoints: Waypoint[];
  // Whether grace expiry will auto-finalize this flight (session-scoped).
  autoEnd: boolean;
  // Sticky GPS/permission failure; cleared by the next fix or start/stop.
  error: EngineError | null;
}

export type EngineErrorCode =
  | "permission-denied"
  | "unavailable"
  // WAL writes are failing: fixes survive only in memory until it clears.
  | "storage"
  // Another tab holds the recorder lock (PWA); this engine stays passive.
  | "busy";

export interface EngineError {
  code: EngineErrorCode;
  message: string;
}

// Signal-then-read: the engine never pushes payloads. subscribe() fires a
// coalesced "changed" signal (once per task, no matter how many fixes a
// replay burst delivers) and consumers read snapshotSync() — every read is
// a complete, consistent view, so there is no delta stream to replay and
// nothing to tear against a burst.
export interface RecordingEngine {
  // First call hydrates from the WAL; afterwards a pure view of live state.
  getSnapshot(): Promise<EngineSnapshot>;
  // Pure, cached view of in-memory state: stable identity between changes,
  // fresh after every change (useSyncExternalStore-compatible).
  snapshotSync(): EngineSnapshot;
  // Coalesced change signal; returns unsubscribe.
  subscribe(listener: () => void): () => void;
  start(options?: StartOptions): Promise<void>;
  // Long-press mid-flight: append an ad-hoc nav target. at = [longitude,
  // latitude] (map/pin tuple order). Joins this flight only; plan untouched.
  addAdhocWaypoint(at: LngLat): Promise<void>;
  // "Remove next": advance past the current nav target (planned or ad-hoc),
  // silently. No-op when there is no target left.
  removeNextWaypoint(): Promise<void>;
  // "I'm done flying": journals the pilot's stop into the session, so
  // status derives to "ended" — durable, crash-safe, collected by the
  // same persist-first path as a detected landing. Nothing is cleared.
  end(): void;
  // "The engine's copy is no longer needed": drop the session and clear
  // the WAL — after the consumer persisted an ended flight, or to cancel
  // an un-launched session. Deliberately returns nothing: persist from a
  // snapshot BEFORE discarding; there is no track handed out at the
  // moment the durable copy is destroyed.
  discard(): Promise<void>;
  // landed → recording: pilot overrides a detected touchdown.
  dismissLanding(): void;
}
