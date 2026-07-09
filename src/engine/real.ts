import { bearingBetween } from "../flight/nav";
import { haversineMeters } from "../flight/stats";
import { detectTakeoff, gpsReadyIndex } from "../flight/takeoff";
import type {
  EngineSnapshot,
  EngineStatus,
  Fix,
  RecordingEngine,
} from "./types";
import {
  appendWalFix,
  clearWal,
  readWal,
  writeWalSession,
  type WalSession,
} from "./wal";

// Thresholds in takeoff.ts are tuned for ~1 Hz fixes; platforms can burst
// duplicates far faster (PPG Flyer exports contain 44 ms doubles).
const MIN_FIX_INTERVAL_MS = 500;
const DERIVE_COURSE_MIN_SPEED_MPS = 0.5;

export class GeolocationRecordingEngine implements RecordingEngine {
  private fixListeners = new Set<(fix: Fix) => void>();
  private statusListeners = new Set<(status: EngineStatus) => void>();
  private buffer: Fix[] = [];
  private session: WalSession | null = null;
  private watchId: number | null = null;
  private lastStatus: EngineStatus = "idle";
  private walQueue: Promise<unknown> = Promise.resolve();

  async getSnapshot(): Promise<EngineSnapshot> {
    await this.walQueue;
    const { session, fixes } = await readWal();
    this.session = session;
    this.buffer = fixes;
    if (!session) return { status: "idle", startedAt: null, track: [] };
    this.ensureWatch();
    const status = this.deriveStatus();
    this.lastStatus = status;
    if (status !== "recording") return { status, startedAt: null, track: [] };
    const track = this.buffer.slice(session.takeoffIndex!);
    return { status, startedAt: track[0]?.timestamp ?? null, track };
  }

  async start(): Promise<void> {
    await clearWal();
    this.session = { armedAt: Date.now(), takeoffIndex: null };
    this.buffer = [];
    await writeWalSession(this.session);
    this.setStatus("acquiring");
    this.ensureWatch();
  }

  async stop(): Promise<Fix[]> {
    const track =
      this.session && this.session.takeoffIndex !== null
        ? this.buffer.slice(this.session.takeoffIndex)
        : [];
    this.clearWatch();
    this.session = null;
    this.buffer = [];
    await this.walQueue;
    await clearWal();
    this.setStatus("idle");
    return track;
  }

  onFix(listener: (fix: Fix) => void): () => void {
    this.fixListeners.add(listener);
    return () => {
      this.fixListeners.delete(listener);
    };
  }

  onStatus(listener: (status: EngineStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  private deriveStatus(): EngineStatus {
    if (!this.session) return "idle";
    if (this.session.takeoffIndex !== null) return "recording";
    return gpsReadyIndex(this.buffer) !== null ? "armed" : "acquiring";
  }

  private setStatus(status: EngineStatus) {
    if (status === this.lastStatus) return;
    this.lastStatus = status;
    for (const listener of this.statusListeners) listener(status);
  }

  private ensureWatch() {
    if (this.watchId !== null) return;
    if (!("geolocation" in navigator)) {
      console.warn("geolocation unavailable");
      return;
    }
    this.watchId = navigator.geolocation.watchPosition(
      (position) => this.handlePosition(position),
      (error) => console.warn("geolocation error:", error.message),
      { enableHighAccuracy: true, maximumAge: 0 },
    );
  }

  private clearWatch() {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
  }

  private handlePosition(position: GeolocationPosition) {
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
    this.enqueueWal(() => appendWalFix(fix));

    for (const listener of this.fixListeners) listener(fix);

    if (this.session.takeoffIndex === null) {
      const takeoffIndex = detectTakeoff(this.buffer);
      if (takeoffIndex !== null) {
        this.session = { ...this.session, takeoffIndex };
        const session = this.session;
        this.enqueueWal(() => writeWalSession(session));
      }
    }
    this.setStatus(this.deriveStatus());
  }

  private enqueueWal(operation: () => Promise<void>) {
    this.walQueue = this.walQueue.then(operation).catch((error) => {
      console.error("wal write failed:", error);
    });
  }

  private toFix(position: GeolocationPosition, previous: Fix | undefined): Fix {
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
