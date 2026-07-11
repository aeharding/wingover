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
  track: Fix[];
  // Touchdown timestamp once landing is detected (pending finalization).
  landingAt: number | null;
  waypoints: Waypoint[];
}

export type EngineErrorCode = "permission-denied" | "unavailable";

export interface EngineError {
  code: EngineErrorCode;
  message: string;
}

export interface EngineEvents {
  fix: (fix: Fix) => void;
  status: (status: EngineStatus) => void;
  error: (error: EngineError) => void;
}

export interface RecordingEngine {
  // First call hydrates from the WAL; afterwards a pure view of live state.
  getSnapshot(): Promise<EngineSnapshot>;
  // Synchronous view of in-memory state. Engine event listeners must use
  // this instead of awaiting getSnapshot(): a replay burst delivers many
  // fixes in one task, so a snapshot applied across an await is stale.
  snapshotSync(): EngineSnapshot;
  // Current lifecycle status, live even mid-burst (React state is not).
  readonly status: EngineStatus;
  start(options?: StartOptions): Promise<void>;
  // Mid-flight additions join this flight only; the plan is untouched.
  addWaypoints(waypoints: Waypoint[]): Promise<void>;
  stop(): Promise<Fix[]>;
  // Subscribe to an engine event; returns unsubscribe.
  on<E extends keyof EngineEvents>(
    event: E,
    listener: EngineEvents[E],
  ): () => void;
  // landed → recording: pilot overrides a detected touchdown.
  dismissLanding(): void;
}
