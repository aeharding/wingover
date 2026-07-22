import { useEffect, useEffectEvent, useRef, useState } from "react";

import type { Fix } from "../../engine/types";
import {
  cursorFor,
  DEFAULT_REPLAY_SPEED,
  REPLAY_SPEEDS,
  ReplayClock,
} from "./replayClock";

// The delivery cadence, NOT the fidelity: each tick releases every recorded
// fix whose compressed timestamp has come due (at 30x a 100ms tick carries
// ~3 fixes), and the map renders per released fix exactly as it does live.
// There is no rAF loop and no interpolation — replay is faithful to the
// recorded cadence by construction, and 10 wakeups/s only exist while
// playing.
const TICK_MS = 100;

// Playback speed is a device preference (the pane-open/pane-width
// precedent): the feed rebuilds on every flight switch and pane reopen,
// so without this the speed snapped back to the default each time.
const SPEED_KEY = "wingover.replaySpeed";

function storedSpeed(): number {
  try {
    const value = Number(localStorage.getItem(SPEED_KEY));
    return REPLAY_SPEEDS.includes(value) ? value : DEFAULT_REPLAY_SPEED;
  } catch {
    return DEFAULT_REPLAY_SPEED;
  }
}

function rememberSpeed(speed: number): void {
  try {
    localStorage.setItem(SPEED_KEY, String(speed));
  } catch {
    return;
  }
}

export interface ReplayFeed {
  // The prefix of the recording that has "happened" — LiveTrackMap's track.
  track: Fix[];
  latest: Fix;
  playing: boolean;
  atEnd: boolean;
  speed: number;
  simTime: number;
  elapsedSeconds: number;
  totalSeconds: number;
  togglePlay: () => void;
  seek: (t: number) => void;
  // Media-stop: halt AND rewind to the start (pause keeps the position).
  stop: () => void;
  // Scrubbing pauses the clock and resumes on release if it was playing.
  beginScrub: () => void;
  endScrub: () => void;
  cycleSpeed: () => void;
}

/**
 * Drives a recorded track through the replay clock and exposes the flown
 * prefix + the current fix. The caller must guarantee at least 2 fixes
 * and remount (key) per flight. autoplay starts the clock on mount (the
 * phone's Replay pill); initialAt seeds the position (timeline
 * continuity across dock swaps — clamped into this track's range, which
 * also absorbs a position left beyond a fresh trim's new edge).
 */
export function useReplayFeed(
  fixes: Fix[],
  autoplay = false,
  initialAt: number | null = null,
): ReplayFeed {
  const t0 = fixes[0].timestamp;
  const t1 = fixes[fixes.length - 1].timestamp;
  const seededAt =
    initialAt === null ? t0 : Math.min(t1, Math.max(t0, initialAt));
  const [clock] = useState(() => {
    const created = new ReplayClock(t0, t1, storedSpeed());
    created.seek(seededAt, Date.now());
    if (autoplay) created.play(Date.now());
    return created;
  });
  const [state, setState] = useState(() => ({
    index: cursorFor(fixes, seededAt),
    simTime: seededAt,
    playing: autoplay,
    speed: clock.speed,
  }));
  const wasPlayingRef = useRef(false);

  // Re-read the clock and publish; the only writer of React state, so every
  // control is "mutate the clock, then sync". A plain function so event
  // handlers may call it; effects go through the effect events below.
  function sync() {
    const now = Date.now();
    if (clock.playing && clock.atEnd(now)) clock.pause(now);
    const simTime = clock.timeAt(now);
    const index = cursorFor(fixes, simTime);
    setState((prior) =>
      prior.index === index &&
      prior.simTime === simTime &&
      prior.playing === clock.playing &&
      prior.speed === clock.speed
        ? prior
        : { index, simTime, playing: clock.playing, speed: clock.speed },
    );
  }

  const tick = useEffectEvent(() => sync());

  useEffect(() => {
    if (!state.playing) return;
    const timer = setInterval(() => tick(), TICK_MS);
    return () => clearInterval(timer);
  }, [state.playing]);

  // Backgrounded mid-replay: FREEZE the moment rather than racing ahead on
  // a throttled timer (the wall-anchored clock would leap on return), then
  // resume on the way back if it was playing — a quick tab switch never
  // costs the pilot their place or a press.
  const resumeOnVisibleRef = useRef(false);

  const syncVisibility = useEffectEvent(() => {
    const now = Date.now();
    if (document.visibilityState === "hidden") {
      if (!clock.playing) return;
      resumeOnVisibleRef.current = true;
      clock.pause(now);
      sync();
      return;
    }
    if (!resumeOnVisibleRef.current) return;
    resumeOnVisibleRef.current = false;
    // Never auto-RESTART: play() at the end would wrap to the beginning.
    if (!clock.atEnd(now)) {
      clock.play(now);
      sync();
    }
  });

  useEffect(() => {
    const onVisibility = () => syncVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  function togglePlay() {
    const now = Date.now();
    if (clock.playing) clock.pause(now);
    else clock.play(now);
    sync();
  }

  function seek(t: number) {
    clock.seek(t, Date.now());
    sync();
  }

  function stop() {
    const now = Date.now();
    clock.pause(now);
    clock.seek(t0, now);
    sync();
  }

  function beginScrub() {
    wasPlayingRef.current = clock.playing;
    if (clock.playing) clock.pause(Date.now());
    sync();
  }

  function endScrub() {
    const now = Date.now();
    if (wasPlayingRef.current && !clock.atEnd(now)) clock.play(now);
    wasPlayingRef.current = false;
    sync();
  }

  function cycleSpeed() {
    const at = REPLAY_SPEEDS.indexOf(clock.speed);
    const next = REPLAY_SPEEDS[(at + 1) % REPLAY_SPEEDS.length];
    clock.setSpeed(next, Date.now());
    rememberSpeed(next);
    sync();
  }

  return {
    track: fixes.slice(0, state.index),
    latest: fixes[state.index - 1],
    playing: state.playing,
    atEnd: state.simTime >= t1,
    speed: state.speed,
    simTime: state.simTime,
    elapsedSeconds: (state.simTime - t0) / 1000,
    totalSeconds: (t1 - t0) / 1000,
    togglePlay,
    seek,
    stop,
    beginScrub,
    endScrub,
    cycleSpeed,
  };
}
