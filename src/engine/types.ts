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
// pilot may dismiss. "ended": landing grace expired (fix time) — the flight
// of record is final and waits durably in the WAL until collected via
// stop(); a crash between finalization and persistence loses nothing.
// A flight's waypoint: an anonymous geofence (no name), copied from a
// plan pin at flight start (flight/session.ts). Owned by the session —
// never a live view of the plan.
export interface Waypoint {
  id: string;
  latitude: number;
  longitude: number;
  radiusM: number;
}

export interface StartOptions {
  waypoints?: Waypoint[];
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
  waypoints: Waypoint[];
  // Sticky GPS/permission failure; cleared by the next fix or start/stop.
  error: EngineError | null;
}

export type EngineErrorCode = "permission-denied" | "unavailable";

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
  // Mid-flight additions join this flight only; the plan is untouched.
  addWaypoints(waypoints: Waypoint[]): Promise<void>;
  stop(): Promise<Fix[]>;
  // landed → recording: pilot overrides a detected touchdown.
  dismissLanding(): void;
}
