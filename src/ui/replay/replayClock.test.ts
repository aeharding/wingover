import { describe, expect, it } from "vitest";

import type { Fix } from "../../engine/types";
import { cursorFor, ReplayClock } from "./replayClock";

const T0 = 1_000_000;
const T1 = T0 + 600_000; // a 10 minute flight

function fix(timestamp: number): Fix {
  return {
    timestamp,
    latitude: 0,
    longitude: 0,
    altitude: 0,
    speed: 0,
    course: 0,
    climbRate: 0,
    horizontalAccuracy: 5,
    verticalAccuracy: 5,
  };
}

describe("ReplayClock", () => {
  it("holds at the window start while paused", () => {
    const clock = new ReplayClock(T0, T1, 30);
    expect(clock.playing).toBe(false);
    expect(clock.timeAt(999)).toBe(T0);
    expect(clock.timeAt(1e12)).toBe(T0);
  });

  it("advances at the compression rate while playing", () => {
    const clock = new ReplayClock(T0, T1, 30);
    clock.play(5000);
    expect(clock.playing).toBe(true);
    expect(clock.timeAt(5000)).toBe(T0);
    expect(clock.timeAt(6000)).toBe(T0 + 30_000);
  });

  it("pause freezes time and play resumes continuously", () => {
    const clock = new ReplayClock(T0, T1, 30);
    clock.play(0);
    clock.pause(2000); // sim +60s
    expect(clock.playing).toBe(false);
    expect(clock.timeAt(50_000)).toBe(T0 + 60_000);
    clock.play(100_000);
    expect(clock.timeAt(101_000)).toBe(T0 + 90_000);
  });

  it("speed changes never jump the current moment", () => {
    const clock = new ReplayClock(T0, T1, 30);
    clock.play(0);
    clock.setSpeed(60, 1000); // sim +30s at the switch
    expect(clock.timeAt(1000)).toBe(T0 + 30_000);
    expect(clock.timeAt(2000)).toBe(T0 + 90_000);
    expect(clock.speed).toBe(60);
  });

  it("seek clamps to the window", () => {
    const clock = new ReplayClock(T0, T1, 30);
    clock.seek(T0 - 99_999, 0);
    expect(clock.timeAt(0)).toBe(T0);
    clock.seek(T1 + 99_999, 0);
    expect(clock.timeAt(0)).toBe(T1);
  });

  it("seeking while playing re-anchors from the seeked moment", () => {
    const clock = new ReplayClock(T0, T1, 30);
    clock.play(0);
    clock.seek(T0 + 120_000, 4000);
    expect(clock.timeAt(4000)).toBe(T0 + 120_000);
    expect(clock.timeAt(5000)).toBe(T0 + 150_000);
  });

  it("holds at the end, and play at the end restarts", () => {
    const clock = new ReplayClock(T0, T1, 60);
    clock.play(0);
    // 600s of flight at 60x = 10s of wall clock; far past that, time holds.
    expect(clock.timeAt(60_000)).toBe(T1);
    expect(clock.atEnd(60_000)).toBe(true);
    clock.play(60_000);
    expect(clock.timeAt(60_000)).toBe(T0);
    expect(clock.atEnd(60_000)).toBe(false);
  });
});

describe("cursorFor", () => {
  const fixes = [0, 1000, 2000, 3000, 4000].map((t) => fix(T0 + t));

  it("never returns less than one fix", () => {
    expect(cursorFor(fixes, T0 - 5000)).toBe(1);
  });

  it("counts fixes at or before the cursor time", () => {
    expect(cursorFor(fixes, T0)).toBe(1);
    expect(cursorFor(fixes, T0 + 999)).toBe(1);
    expect(cursorFor(fixes, T0 + 1000)).toBe(2);
    expect(cursorFor(fixes, T0 + 2500)).toBe(3);
    expect(cursorFor(fixes, T0 + 4000)).toBe(5);
    expect(cursorFor(fixes, T0 + 99_999)).toBe(5);
  });
});
