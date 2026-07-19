import type { PositionSource, SourcePosition } from "./real";
import { FlightSimulator } from "./simulator";
import type { Fix } from "./types";

const SESSION_KEY = "wingover.sim-session";

interface SimSession {
  seed: number;
  startedAt: number;
  compression: number;
}

function toSourcePosition(fix: Fix): SourcePosition {
  return {
    timestamp: fix.timestamp,
    coords: {
      latitude: fix.latitude,
      longitude: fix.longitude,
      accuracy: fix.horizontalAccuracy,
      altitude: fix.altitude,
      altitudeAccuracy: fix.verticalAccuracy,
      speed: fix.speed,
      heading: fix.course,
    },
  };
}

// The simulator as just another sensor: mock and real GPS share the ENTIRE
// engine — WAL, replay, takeoff/landing/ended, waypoints. Fix timestamps
// advance in sim time while delivery runs compressed on the wall clock; to
// the engine that is simply a continuous burst replay, which the fix-time
// doctrine already handles. The source owns its session persistence the
// way native capture owns its log: a fresh watch (no `since` cursor)
// starts a new deterministic flight, a rehydrating watch resumes the same
// one and redelivers everything after the cursor.
export function createSimulatorSource(
  compression: number,
  home?: { latitude: number; longitude: number },
): PositionSource {
  return {
    watch(onPositions, onError, options) {
      void onError;
      const since = options?.since;
      let session: SimSession | null = null;
      if (since != null) {
        const raw = localStorage.getItem(SESSION_KEY);
        session = raw ? (JSON.parse(raw) as SimSession) : null;
      }
      if (!session) {
        session = {
          seed: Date.now() % 100000,
          startedAt: Date.now(),
          compression,
        };
        localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      }
      const active = session;
      const simulator = new FlightSimulator(active.seed, active.startedAt, home);
      let emitted = 0;
      const timer = setInterval(
        () => {
          const elapsed = Math.floor(
            ((Date.now() - active.startedAt) / 1000) * active.compression,
          );
          const buffer = simulator.fixesUpTo(Math.max(elapsed, 1));
          // Everything a tick produced is one batch, exactly like a native
          // poll response — compressed delivery IS a continuous replay.
          const batch: SourcePosition[] = [];
          while (emitted < buffer.length) {
            const fix = buffer[emitted++];
            if (since != null && fix.timestamp <= since) continue;
            batch.push(toSourcePosition(fix));
          }
          if (batch.length > 0) onPositions(batch);
        },
        Math.max(50, 1000 / active.compression),
      );
      return () => clearInterval(timer);
    },
  };
}
