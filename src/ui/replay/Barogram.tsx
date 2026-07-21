import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import type { Fix } from "../../engine/types";
import { formatAirtime, formatDuration } from "../../flight/format";
import { barogramPaths } from "./barogramPath";

import "./Barogram.css";

const HEIGHT = 64;
const STEP_MS = 10_000;
const BIG_STEP_MS = 60_000;

interface BarogramProps {
  // The WHOLE flight — the profile is the timeline, not the flown prefix.
  track: Fix[];
  simTime: number;
  onSeek: (t: number) => void;
  onScrubStart: () => void;
  onScrubEnd: () => void;
}

/**
 * The altitude profile as the scrub track: a plain-SVG barogram whose
 * playhead is the replay position. Interaction follows the ZoomControl
 * doctrine — pointer capture, and during a drag the playhead is written
 * straight to the DOM, never through React state.
 */
export default function Barogram({
  track,
  simTime,
  onSeek,
  onScrubStart,
  onScrubEnd,
}: BarogramProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [scrubbing, setScrubbing] = useState(false);

  const t0 = track[0].timestamp;
  const t1 = track[track.length - 1].timestamp;
  const spanMs = Math.max(1, t1 - t0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(() =>
      setWidth(Math.round(host.clientWidth)),
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const paths = barogramPaths(track, width, HEIGHT);

  // Straight-to-DOM positioning (never React state — the ZoomControl
  // doctrine): a plain function so the drag handlers can call it.
  function placePlayhead(t: number) {
    const clamped = Math.min(t1, Math.max(t0, t));
    const x = ((clamped - t0) / spanMs) * width;
    if (playheadRef.current)
      playheadRef.current.style.transform = `translateX(${x}px)`;
    if (bubbleRef.current) {
      // Keep the bubble on-chart near the edges.
      const bx = Math.min(Math.max(x, 28), Math.max(width - 28, 28));
      bubbleRef.current.style.transform = `translateX(${bx}px) translateX(-50%)`;
      bubbleRef.current.textContent = formatDuration((clamped - t0) / 1000);
    }
  }

  const placeForRender = useEffectEvent(() => placePlayhead(simTime));

  // Playback and external seeks position the playhead; an active scrub owns
  // it imperatively above (zero drag lag) and this pass then agrees with it.
  useLayoutEffect(() => {
    placeForRender();
  }, [simTime, width]);

  function timeAtPointer(event: ReactPointerEvent) {
    const rect = hostRef.current!.getBoundingClientRect();
    const fraction = Math.min(
      1,
      Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)),
    );
    return t0 + fraction * spanMs;
  }

  function scrubTo(event: ReactPointerEvent) {
    const t = timeAtPointer(event);
    placePlayhead(t);
    onSeek(t);
  }

  const elapsedSeconds = (simTime - t0) / 1000;
  const totalSeconds = spanMs / 1000;

  return (
    <div
      ref={hostRef}
      className="barogram"
      data-testid="barogram"
      role="slider"
      tabIndex={0}
      aria-label="Flight position"
      aria-valuemin={0}
      aria-valuemax={Math.round(totalSeconds)}
      aria-valuenow={Math.round(elapsedSeconds)}
      aria-valuetext={`${formatAirtime(elapsedSeconds)} of ${formatAirtime(totalSeconds)}`}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        setScrubbing(true);
        onScrubStart();
        scrubTo(event); // tap is a seek too
      }}
      onPointerMove={(event) => {
        if (scrubbing) scrubTo(event);
      }}
      onPointerUp={() => {
        if (!scrubbing) return;
        setScrubbing(false);
        onScrubEnd();
      }}
      onPointerCancel={() => {
        if (!scrubbing) return;
        setScrubbing(false);
        onScrubEnd();
      }}
      onKeyDown={(event: ReactKeyboardEvent) => {
        const step = event.shiftKey ? BIG_STEP_MS : STEP_MS;
        let to: number | null = null;
        if (event.key === "ArrowLeft") to = simTime - step;
        else if (event.key === "ArrowRight") to = simTime + step;
        else if (event.key === "Home") to = t0;
        else if (event.key === "End") to = t1;
        if (to === null) return;
        event.preventDefault();
        onSeek(Math.min(t1, Math.max(t0, to)));
      }}
    >
      {width >= 2 && (
        <svg
          className="barogram-svg"
          viewBox={`0 0 ${width} ${HEIGHT}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path className="barogram-area" d={paths.area} />
          <path className="barogram-outline" d={paths.outline} />
        </svg>
      )}
      <div ref={playheadRef} className="barogram-playhead" aria-hidden="true" />
      <div
        ref={bubbleRef}
        className={scrubbing ? "barogram-bubble visible" : "barogram-bubble"}
        aria-hidden="true"
      />
    </div>
  );
}
