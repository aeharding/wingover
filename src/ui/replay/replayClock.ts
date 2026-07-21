import type { Fix } from "../../engine/types";

// Replay compresses recorded time onto the wall clock exactly like the
// dev GPX mock (engine/gpxSource.ts): simTime advances at `speed` recorded
// seconds per wall second. Same vocabulary as ?mock-speed on purpose.
export const REPLAY_SPEEDS: readonly number[] = [10, 30, 60];
export const DEFAULT_REPLAY_SPEED = 30;

/**
 * The replay time cursor: a pausable, seekable, speed-changeable clock over
 * the recorded window [t0, t1] (fix timestamps, epoch ms). Wall time is
 * injected into every method — the class never reads Date.now() — so the
 * math is exact under test. Reaching t1 holds there (the consumer sees
 * atEnd and pauses); play() while at the end restarts from t0.
 */
export class ReplayClock {
  // simTime at the anchor moment; the whole state when paused.
  private base: number;
  // Wall time the clock last (re-)anchored at; null = paused.
  private anchor: number | null = null;
  private rate: number;

  constructor(
    private readonly t0: number,
    private readonly t1: number,
    rate: number = DEFAULT_REPLAY_SPEED,
  ) {
    this.base = t0;
    this.rate = rate;
  }

  get playing(): boolean {
    return this.anchor !== null;
  }

  get speed(): number {
    return this.rate;
  }

  timeAt(nowWall: number): number {
    const t =
      this.anchor === null
        ? this.base
        : this.base + (nowWall - this.anchor) * this.rate;
    return Math.min(this.t1, Math.max(this.t0, t));
  }

  play(nowWall: number): void {
    // Re-anchor from the current moment so a pause/play round trip is
    // continuous; at the end, play means "again".
    this.base =
      this.timeAt(nowWall) >= this.t1 ? this.t0 : this.timeAt(nowWall);
    this.anchor = nowWall;
  }

  pause(nowWall: number): void {
    this.base = this.timeAt(nowWall);
    this.anchor = null;
  }

  seek(t: number, nowWall: number): void {
    this.base = Math.min(this.t1, Math.max(this.t0, t));
    if (this.anchor !== null) this.anchor = nowWall;
  }

  setSpeed(rate: number, nowWall: number): void {
    // Freeze the current moment first so the rate change never jumps time.
    this.base = this.timeAt(nowWall);
    if (this.anchor !== null) this.anchor = nowWall;
    this.rate = rate;
  }

  atEnd(nowWall: number): boolean {
    return this.timeAt(nowWall) >= this.t1;
  }
}

/**
 * How many fixes have HAPPENED by simTime t — the prefix length replay
 * feeds the map (track.slice(0, cursor)). Binary search over the
 * timestamp-sorted track; never less than 1, so the aircraft always has a
 * fix to stand on.
 */
export function cursorFor(fixes: Fix[], t: number): number {
  let lo = 0;
  let hi = fixes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (fixes[mid].timestamp <= t) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(1, lo);
}
