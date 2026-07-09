import { detectTakeoff, gpsReadyIndex } from "../flight/takeoff";
import { FlightSimulator } from "./simulator";
import type {
  EngineSnapshot,
  EngineStatus,
  Fix,
  RecordingEngine,
} from "./types";

const WAL_KEY = "wingover.mock-wal";

interface MockWal {
  armedAt: number;
  seed: number;
  compression: number;
  takeoffIndex: number | null;
}

function readWal(): MockWal | null {
  const raw = localStorage.getItem(WAL_KEY);
  return raw ? (JSON.parse(raw) as MockWal) : null;
}

function writeWal(wal: MockWal) {
  localStorage.setItem(WAL_KEY, JSON.stringify(wal));
}

function deriveStatus(wal: MockWal, buffer: Fix[]): EngineStatus {
  if (wal.takeoffIndex !== null) return "recording";
  return gpsReadyIndex(buffer) !== null ? "armed" : "acquiring";
}

const initialSearch = location.search;

function compressionFromUrl(): number {
  const raw = new URLSearchParams(initialSearch).get("mock-speed");
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
}

export class MockRecordingEngine implements RecordingEngine {
  private fixListeners = new Set<(fix: Fix) => void>();
  private statusListeners = new Set<(status: EngineStatus) => void>();
  private simulator: FlightSimulator | null = null;
  private simulatorSeed: number | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private emitted = 0;
  private lastStatus: EngineStatus = "idle";

  async getSnapshot(): Promise<EngineSnapshot> {
    const wal = readWal();
    if (!wal) return { status: "idle", startedAt: null, track: [] };
    const buffer = this.bufferAt(wal, Date.now());
    this.emitted = buffer.length;
    this.ensureTimer(wal);
    const status = deriveStatus(wal, buffer);
    this.lastStatus = status;
    if (status !== "recording") return { status, startedAt: null, track: [] };
    const track = buffer.slice(wal.takeoffIndex!);
    return {
      status,
      startedAt: track[0]?.timestamp ?? null,
      track,
    };
  }

  async start(): Promise<void> {
    writeWal({
      armedAt: Date.now(),
      seed: Date.now() % 100000,
      compression: compressionFromUrl(),
      takeoffIndex: null,
    });
    this.emitted = 0;
    this.lastStatus = "acquiring";
    for (const listener of this.statusListeners) listener("acquiring");
    const wal = readWal();
    if (wal) this.ensureTimer(wal);
  }

  async stop(): Promise<Fix[]> {
    const wal = readWal();
    const track =
      wal && wal.takeoffIndex !== null
        ? this.bufferAt(wal, Date.now()).slice(wal.takeoffIndex)
        : [];
    localStorage.removeItem(WAL_KEY);
    this.clearTimer();
    this.simulator = null;
    this.simulatorSeed = null;
    this.emitted = 0;
    this.lastStatus = "idle";
    for (const listener of this.statusListeners) listener("idle");
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

  private bufferAt(wal: MockWal, now: number): Fix[] {
    if (!this.simulator || this.simulatorSeed !== wal.seed) {
      this.simulator = new FlightSimulator(wal.seed, wal.armedAt);
      this.simulatorSeed = wal.seed;
    }
    const flightSeconds = Math.floor(
      ((now - wal.armedAt) / 1000) * wal.compression,
    );
    return this.simulator.fixesUpTo(Math.max(flightSeconds, 1));
  }

  private ensureTimer(wal: MockWal) {
    if (this.timer) return;
    const interval = Math.max(50, 1000 / wal.compression);
    this.timer = setInterval(() => {
      const current = readWal();
      if (!current) {
        this.clearTimer();
        return;
      }
      const buffer = this.bufferAt(current, Date.now());
      for (let i = this.emitted; i < buffer.length; i++) {
        const fix = buffer[i];
        for (const listener of this.fixListeners) listener(fix);
      }
      this.emitted = buffer.length;
      let wal = current;
      if (wal.takeoffIndex === null) {
        const takeoffIndex = detectTakeoff(buffer);
        if (takeoffIndex !== null) {
          wal = { ...wal, takeoffIndex };
          writeWal(wal);
        }
      }
      const status = deriveStatus(wal, buffer);
      if (status !== this.lastStatus) {
        this.lastStatus = status;
        for (const listener of this.statusListeners) listener(status);
      }
    }, interval);
  }

  private clearTimer() {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
