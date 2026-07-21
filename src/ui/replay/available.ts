import type { Fix } from "../../engine/types";
import type { Flight } from "../../storage/db";

// Shorter than this there is nothing to watch (and the 11-second e2e
// fixture must stay replayable).
export const MIN_REPLAY_SPAN_MS = 10_000;

/** Whether a flight has enough recording to be worth a replay control. */
export function replayAvailable(flight: Flight | null, track: Fix[]): boolean {
  return (
    flight !== null &&
    track.length >= 2 &&
    track[track.length - 1].timestamp - track[0].timestamp >= MIN_REPLAY_SPAN_MS
  );
}
