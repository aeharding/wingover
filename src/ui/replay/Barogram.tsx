import { contractOutline } from "ionicons/icons";
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
import NativeIcon from "../components/NativeIcon";
import { barogramPaths } from "./barogramPath";

import "./Barogram.css";

const HEIGHT = 72;
const STEP_MS = 10_000;
const BIG_STEP_MS = 60_000;

// A 2h+ flight on a phone is ~18s per pixel; zooming makes single moments
// hittable. Tightest window: ~13px per second on a phone.
const MIN_WINDOW_MS = 30_000;
// Wheel-zoom rates (ctrlKey = trackpad pinch, which reports small deltas).
const WHEEL_RATE = 0.002;
const PINCH_RATE = 0.01;
// Dragging the playhead into this edge band pans a zoomed window.
const EDGE_PX = 28;
const EDGE_PAN_FRACTION = 0.015;

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
 * playhead is the replay position. Drag always scrubs (pointer capture,
 * playhead written straight to the DOM — the ZoomControl doctrine).
 * Zoom always zooms: pinch on touch, wheel/trackpad on desktop, anchored
 * at the fingers/cursor. There is deliberately NO pan gesture — dragging
 * the playhead against the window edge pans, and while playing the
 * window follows the playhead — so drag never has two meanings.
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
  // Active pointers (id → x) and the live pinch, if any. Refs, not state:
  // these change at pointer rate and drive no render of their own.
  const pointersRef = useRef(new Map<number, number>());
  const pinchDistRef = useRef<number | null>(null);
  const [width, setWidth] = useState(0);
  const [scrubbing, setScrubbing] = useState(false);
  // The visible time window; null = the whole flight.
  const [timeWindow, setTimeWindow] = useState<{
    start: number;
    end: number;
  } | null>(null);

  const t0 = track[0].timestamp;
  const t1 = track[track.length - 1].timestamp;
  const spanMs = Math.max(1, t1 - t0);
  const w0 = timeWindow?.start ?? t0;
  const w1 = timeWindow?.end ?? t1;
  const wspan = Math.max(1, w1 - w0);

  // While playing (or after an external seek), a zoomed window follows the
  // playhead: re-anchor it to 30% once the playhead nears the right edge,
  // or pull it back when the playhead left the window. Adjusted during
  // render (guarded, converging) per React doctrine — never in an effect.
  if (timeWindow && !scrubbing) {
    let start: number | null = null;
    if (simTime > w1 - wspan * 0.1) start = simTime - wspan * 0.3;
    else if (simTime < w0) start = simTime - wspan * 0.1;
    if (start !== null) {
      const clamped = Math.min(Math.max(start, t0), t1 - wspan);
      if (clamped !== timeWindow.start)
        setTimeWindow({ start: clamped, end: clamped + wspan });
    }
  }

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(() =>
      setWidth(Math.round(host.clientWidth)),
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // Anchored zoom: the moment under the cursor/fingers stays put while the
  // window tightens or relaxes around it. Fully relaxed = null (whole
  // flight); a flight shorter than the minimum window can't zoom at all.
  // A plain function so the pinch handlers may call it; the native wheel
  // listener goes through the effect event below.
  function applyZoom(anchorX: number, factor: number) {
    const nextSpan = Math.min(spanMs, Math.max(MIN_WINDOW_MS, wspan / factor));
    if (nextSpan >= spanMs) {
      if (timeWindow) setTimeWindow(null);
      return;
    }
    const fraction = Math.min(1, Math.max(0, anchorX / Math.max(1, width)));
    const anchorT = w0 + fraction * wspan;
    const start = Math.min(
      Math.max(anchorT - fraction * nextSpan, t0),
      t1 - nextSpan,
    );
    setTimeWindow({ start, end: start + nextSpan });
  }

  const zoomFromWheel = useEffectEvent((anchorX: number, factor: number) =>
    applyZoom(anchorX, factor),
  );

  // Wheel must preventDefault (the page behind must not scroll/zoom), so
  // it is a native non-passive listener — React's synthetic wheel can't.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = host.getBoundingClientRect();
      const rate = event.ctrlKey ? PINCH_RATE : WHEEL_RATE;
      zoomFromWheel(event.clientX - rect.left, Math.exp(-event.deltaY * rate));
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => host.removeEventListener("wheel", onWheel);
  }, []);

  // Straight-to-DOM positioning (never React state — the ZoomControl
  // doctrine): a plain function so the drag handlers can call it.
  function placePlayhead(t: number) {
    const clamped = Math.min(t1, Math.max(t0, t));
    const x = Math.min(width, Math.max(0, ((clamped - w0) / wspan) * width));
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
  }, [simTime, width, timeWindow]);

  function scrubTo(event: ReactPointerEvent) {
    const rect = hostRef.current!.getBoundingClientRect();
    const x = event.clientX - rect.left;
    // Against the edge of a zoomed window: pan the window under the finger.
    if (timeWindow) {
      const shift =
        x < EDGE_PX
          ? -(wspan * EDGE_PAN_FRACTION)
          : x > width - EDGE_PX
            ? wspan * EDGE_PAN_FRACTION
            : 0;
      if (shift !== 0) {
        const start = Math.min(Math.max(w0 + shift, t0), t1 - wspan);
        if (start !== timeWindow.start)
          setTimeWindow({ start, end: start + wspan });
      }
    }
    const fraction = Math.min(1, Math.max(0, x / Math.max(1, width)));
    const t = w0 + fraction * wspan;
    placePlayhead(t);
    onSeek(t);
  }

  function pinchDistance(): number | null {
    const xs = [...pointersRef.current.values()];
    return xs.length >= 2 ? Math.max(8, Math.abs(xs[0] - xs[1])) : null;
  }

  function pinchMid(): number {
    const xs = [...pointersRef.current.values()];
    return (xs[0] + xs[1]) / 2;
  }

  const elapsedSeconds = (simTime - t0) / 1000;
  const totalSeconds = spanMs / 1000;
  const paths = width >= 2 ? barogramPaths(track, width, HEIGHT, w0, w1) : null;

  return (
    <div className="barogram-frame">
      <div
        ref={hostRef}
        className="barogram"
        data-testid="barogram"
        data-zoomed={timeWindow ? "true" : "false"}
        role="slider"
        tabIndex={0}
        aria-label="Flight position"
        aria-valuemin={0}
        aria-valuemax={Math.round(totalSeconds)}
        aria-valuenow={Math.round(elapsedSeconds)}
        aria-valuetext={`${formatAirtime(elapsedSeconds)} of ${formatAirtime(totalSeconds)}`}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          const rect = event.currentTarget.getBoundingClientRect();
          pointersRef.current.set(event.pointerId, event.clientX - rect.left);
          if (pointersRef.current.size === 2) {
            // Second finger: the scrub becomes a pinch (stop seeking).
            pinchDistRef.current = pinchDistance();
            return;
          }
          setScrubbing(true);
          onScrubStart();
          scrubTo(event); // tap is a seek too
        }}
        onPointerMove={(event) => {
          if (!pointersRef.current.has(event.pointerId)) return;
          const rect = event.currentTarget.getBoundingClientRect();
          pointersRef.current.set(event.pointerId, event.clientX - rect.left);
          if (pinchDistRef.current !== null) {
            const dist = pinchDistance();
            if (dist === null) return;
            applyZoom(pinchMid(), dist / pinchDistRef.current);
            pinchDistRef.current = dist;
            return;
          }
          if (scrubbing) scrubTo(event);
        }}
        onPointerUp={(event) => {
          pointersRef.current.delete(event.pointerId);
          if (pointersRef.current.size < 2) pinchDistRef.current = null;
          if (pointersRef.current.size === 0 && scrubbing) {
            setScrubbing(false);
            onScrubEnd();
          }
        }}
        onPointerCancel={(event) => {
          pointersRef.current.delete(event.pointerId);
          if (pointersRef.current.size < 2) pinchDistRef.current = null;
          if (pointersRef.current.size === 0 && scrubbing) {
            setScrubbing(false);
            onScrubEnd();
          }
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
        {paths && (
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
        <div
          ref={playheadRef}
          className="barogram-playhead"
          aria-hidden="true"
        />
        <div
          ref={bubbleRef}
          className={scrubbing ? "barogram-bubble visible" : "barogram-bubble"}
          aria-hidden="true"
        />
        {timeWindow && (
          <button
            className="barogram-reset"
            aria-label="Show whole flight"
            data-testid="timeline-reset"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => setTimeWindow(null)}
          >
            <NativeIcon icon={contractOutline} />
          </button>
        )}
      </div>
      {/* Which slice of the flight the zoomed graph shows. */}
      {timeWindow && (
        <div className="barogram-overview" aria-hidden="true">
          <div
            className="barogram-overview-window"
            style={{
              left: `${(((w0 - t0) / spanMs) * 100).toFixed(2)}%`,
              width: `${((wspan / spanMs) * 100).toFixed(2)}%`,
            }}
          />
        </div>
      )}
    </div>
  );
}
