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
  // Scrubbing pauses the clock and resumes on release if it was playing.
  beginScrub: () => void;
  endScrub: () => void;
  cycleSpeed: () => void;
}

/**
 * Drives a recorded track through the replay clock and exposes the flown
 * prefix + the current fix. The caller must guarantee at least 2 fixes
 * and remount (key) per flight. autoplay starts the clock on mount (the
 * phone's Replay pill).
 */
export function useReplayFeed(fixes: Fix[], autoplay = false): ReplayFeed {
  const t0 = fixes[0].timestamp;
  const t1 = fixes[fixes.length - 1].timestamp;
  const [clock] = useState(() => {
    const created = new ReplayClock(t0, t1);
    if (autoplay) created.play(Date.now());
    return created;
  });
  const [state, setState] = useState(() => ({
    index: 1,
    simTime: t0,
    playing: autoplay,
    speed: DEFAULT_REPLAY_SPEED,
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

  // Backgrounded mid-replay: hold the moment rather than racing ahead on a
  // throttled timer.
  const holdWhileHidden = useEffectEvent(() => {
    if (document.visibilityState === "hidden" && clock.playing) {
      clock.pause(Date.now());
      sync();
    }
  });

  useEffect(() => {
    const onVisibility = () => holdWhileHidden();
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
    clock.setSpeed(REPLAY_SPEEDS[(at + 1) % REPLAY_SPEEDS.length], Date.now());
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
    beginScrub,
    endScrub,
    cycleSpeed,
  };
}
