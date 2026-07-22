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
import { cx } from "../cx";
import { barogramPaths } from "./barogramPath";
import type { TimelineView } from "./timelineMemory";

import styles from "./Barogram.module.css";

const HEIGHT = 72;
const STEP_MS = 10_000;
const BIG_STEP_MS = 60_000;

// A 2h+ flight on a phone is ~18s per pixel; zooming makes single moments
// hittable. Tightest window: ~13px per second on a phone.
const MIN_WINDOW_MS = 30_000;
// Wheel-zoom rates (ctrlKey = trackpad pinch, which reports small deltas).
const WHEEL_RATE = 0.002;
const PINCH_RATE = 0.01;
// Scrubbing into this edge band pans a zoomed window.
const EDGE_PX = 28;
const EDGE_PAN_FRACTION = 0.015;
// A zoomed press within this travel is a tap (seek); beyond it, a pan.
const TAP_SLOP_PX = 8;

interface BarogramProps {
  // The WHOLE flight — the profile is the timeline, not the flown prefix.
  track: Fix[];
  simTime: number;
  // False while the replay is parked (stopped): the graph renders with no
  // playhead cursor — a scrub or play brings it back.
  playhead: boolean;
  onSeek: (t: number) => void;
  onScrubStart: () => void;
  onScrubEnd: () => void;
  // Clip mode's cut marker, riding the dock's cut point (its simTime):
  // a bracket grip for a trim bound, a knob divider for the split point.
  // Hidden while scrolled outside a zoomed window — a marker pinned to
  // the window edge read as "the cut is here" when it wasn't; bare frame
  // rails running off-screen say "continues beyond" instead. The cursor
  // zone (below) makes it grabbable whenever it IS in view.
  mark?: { value: number; kind: "start" | "end" | "point" };
  // Dim everything outside this window (trim's cut region grays out).
  kept?: { startMs: number; endMs: number };
  // Timeline continuity across dock swaps (see timelineMemory.ts): the
  // zoom window to seed at mount, and a report on every window change.
  initialView?: TimelineView | null;
  onViewChange?: (view: TimelineView | null) => void;
}

/**
 * The altitude profile as the scrub track: a plain-SVG barogram whose
 * playhead is the replay position. Zoom always zooms: pinch on touch,
 * wheel/trackpad on desktop, anchored at the fingers/cursor. Drag is
 * scoped by zoom (per Alex): showing the whole flight, drag scrubs
 * (pointer capture, playhead written straight to the DOM — the
 * ZoomControl doctrine); zoomed in, drag GRABS the timeline and pans it
 * like a map, and a tap seeks. While the playhead is moving (playback,
 * external seeks) a zoomed window still follows it; a hand-panned
 * window otherwise stays where it was put.
 */
export default function Barogram({
  track,
  simTime,
  playhead,
  onSeek,
  onScrubStart,
  onScrubEnd,
  mark,
  kept,
  initialView,
  onViewChange,
}: BarogramProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  // Active pointers (id → x) and the live pinch, if any. Refs, not state:
  // these change at pointer rate and drive no render of their own.
  const pointersRef = useRef(new Map<number, number>());
  const pinchDistRef = useRef<number | null>(null);
  // The chart-surface drag, decided by zoom state: zoomed out it scrubs
  // immediately; zoomed in it starts "pending" (a tap seeks on release)
  // and becomes a pan once it travels past the slop.
  const dragRef = useRef<{
    mode: "scrub" | "pending" | "pan";
    startX: number;
    startW0: number;
  } | null>(null);
  const t0 = track[0].timestamp;
  const t1 = track[track.length - 1].timestamp;
  const spanMs = Math.max(1, t1 - t0);

  const [width, setWidth] = useState(0);
  const [scrubbing, setScrubbing] = useState(false);
  const [panning, setPanning] = useState(false);
  // The visible time window; null = the whole flight. Seeded from the
  // prior dock's view (timeline continuity across mode swaps), and
  // sanitized against THIS track: a clip rewrite may have cut away the
  // ground the old window stood on.
  const [timeWindow, setTimeWindow] = useState<{
    start: number;
    end: number;
  } | null>(() => {
    if (!initialView) return null;
    const span = Math.min(
      Math.max(initialView.end - initialView.start, MIN_WINDOW_MS),
      spanMs,
    );
    if (span >= spanMs) return null;
    const start = Math.min(Math.max(initialView.start, t0), t1 - span);
    return { start, end: start + span };
  });
  // The playhead position last seen by the window-follow below: follow
  // engages only when the playhead MOVED, so a hand-panned window stays
  // where the pilot put it while playback is paused or parked.
  const [lastSim, setLastSim] = useState(simTime);

  const w0 = timeWindow?.start ?? t0;
  const w1 = timeWindow?.end ?? t1;
  const wspan = Math.max(1, w1 - w0);

  // While the playhead moves (playback, an external seek, a clip-mode
  // tap), a zoomed window follows it: re-anchor to 30% once it nears the
  // right edge, or pull back when it left the window. Adjusted during
  // render (guarded, converging) per React doctrine — never in an
  // effect, and never mid-gesture.
  if (lastSim !== simTime) {
    setLastSim(simTime);
    if (timeWindow && !scrubbing && !panning) {
      let start: number | null = null;
      if (simTime > w1 - wspan * 0.1) start = simTime - wspan * 0.3;
      else if (simTime < w0) start = simTime - wspan * 0.1;
      if (start !== null) {
        const clamped = Math.min(Math.max(start, t0), t1 - wspan);
        if (clamped !== timeWindow.start)
          setTimeWindow({ start: clamped, end: clamped + wspan });
      }
    }
  }

  // Measure in a LAYOUT effect: the pane swaps docks (replay <-> clip
  // editors) by remounting, and a freshly mounted chart starts at width
  // 0. Waiting for the ResizeObserver's first delivery painted one frame
  // with no profile and a left-pinned playhead — a visible blink on
  // every mode change. State set in a layout effect commits BEFORE the
  // browser paints (the React-sanctioned measure-then-repaint pattern),
  // so the width-0 frame never reaches the screen; the observer then
  // only tracks real resizes. (Not flushSync in the observer callback:
  // that forced commits mid-overlay-transition and wedged Ionic's action
  // sheet permanently hidden.)
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    setWidth(Math.round(host.clientWidth));
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
    if (playheadRef.current) {
      // Panned out of the zoomed window, the playhead hides rather than
      // pinning to the edge (the trim marks do the same) — a cursor
      // clamped to the rim reads as "the position is here" when it is
      // off-screen. A scrub always keeps t inside the window, so this
      // only ever hides a paused/parked playhead the window moved past.
      playheadRef.current.style.visibility = t < w0 || t > w1 ? "hidden" : "";
      playheadRef.current.style.transform = `translateX(${x}px)`;
    }
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

  // Timeline continuity: report every window change so the NEXT dock
  // mount can seed from it (module memory — nothing re-renders on it).
  const reportView = useEffectEvent(() => onViewChange?.(timeWindow));

  useEffect(() => {
    reportView();
  }, [timeWindow]);

  // Against the edge of a zoomed window: pan the window under the finger
  // (only reachable mid-scrub after a pinch zoomed in under the gesture).
  function edgePan(x: number) {
    if (!timeWindow) return;
    const shift =
      x < EDGE_PX
        ? -(wspan * EDGE_PAN_FRACTION)
        : x > width - EDGE_PX
          ? wspan * EDGE_PAN_FRACTION
          : 0;
    if (shift === 0) return;
    const start = Math.min(Math.max(w0 + shift, t0), t1 - wspan);
    if (start !== timeWindow.start)
      setTimeWindow({ start, end: start + wspan });
  }

  function scrubTo(event: ReactPointerEvent) {
    const rect = hostRef.current!.getBoundingClientRect();
    const x = event.clientX - rect.left;
    edgePan(x);
    const fraction = Math.min(1, Math.max(0, x / Math.max(1, width)));
    const t = w0 + fraction * wspan;
    placePlayhead(t);
    onSeek(t);
  }

  // Grab-the-timeline pan: the moment under the finger at pointerdown
  // stays under it, map-style.
  function panTo(drag: { startX: number; startW0: number }, x: number) {
    if (!timeWindow) return;
    const shift = ((drag.startX - x) / Math.max(1, width)) * wspan;
    const start = Math.min(Math.max(drag.startW0 + shift, t0), t1 - wspan);
    if (start !== timeWindow.start)
      setTimeWindow({ start, end: start + wspan });
  }

  // Pixel position of a moment under the current window (clamped on-chart
  // for marks/cuts scrolled out of a zoomed view).
  function xFor(t: number): number {
    return Math.min(width, Math.max(0, ((t - w0) / wspan) * width));
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

  // The cursor: an invisible grab zone riding the current moment (the
  // playhead in playback, the cut mark in clip mode). Dragging it always
  // scrubs, no matter how far the timeline is zoomed — the chart surface
  // keeps its zoom-scoped drag (pan) but the handle itself stays direct
  // (per Alex). Absent while parked, and while the moment is scrolled
  // out of a zoomed window (grab nothing you cannot see; edge-pan brings
  // it back once a drag reaches the window edge).
  const cursorVisible =
    (playhead || mark !== undefined) &&
    width >= 2 &&
    simTime >= w0 &&
    simTime <= w1;

  return (
    <div className={styles.frame}>
      <div
        ref={hostRef}
        className={styles.chart}
        data-testid="barogram"
        data-zoomed={timeWindow ? "true" : "false"}
        data-panning={panning ? "true" : "false"}
        role="slider"
        tabIndex={0}
        aria-label="Flight position"
        aria-valuemin={0}
        aria-valuemax={Math.round(totalSeconds)}
        aria-valuenow={Math.round(elapsedSeconds)}
        aria-valuetext={`${formatAirtime(elapsedSeconds)} of ${formatAirtime(totalSeconds)}`}
        // Firefox starts a NATIVE drag for SVG content even under pointer
        // capture, which cancels the scrub mid-gesture; kill it at the
        // source.
        onDragStart={(event) => event.preventDefault()}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          const rect = event.currentTarget.getBoundingClientRect();
          const x = event.clientX - rect.left;
          pointersRef.current.set(event.pointerId, x);
          if (pointersRef.current.size >= 2) {
            // Second finger: the gesture becomes a pinch (stop seeking or
            // panning). Any FURTHER contact (a palm, a third finger) only
            // refreshes the pinch baseline — it must never restart the
            // one-finger gesture, which would seek to the stray touch and
            // eat the resume state.
            pinchDistRef.current = pinchDistance();
            dragRef.current = null;
            if (panning) setPanning(false);
            return;
          }
          if (timeWindow) {
            // Zoomed: hold judgment — a tap seeks on release, travel pans.
            dragRef.current = { mode: "pending", startX: x, startW0: w0 };
            return;
          }
          dragRef.current = { mode: "scrub", startX: x, startW0: w0 };
          setScrubbing(true);
          onScrubStart();
          scrubTo(event); // tap is a seek too
        }}
        onPointerMove={(event) => {
          if (!pointersRef.current.has(event.pointerId)) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const x = event.clientX - rect.left;
          pointersRef.current.set(event.pointerId, x);
          if (pinchDistRef.current !== null) {
            const dist = pinchDistance();
            if (dist === null) return;
            applyZoom(pinchMid(), dist / pinchDistRef.current);
            pinchDistRef.current = dist;
            return;
          }
          const drag = dragRef.current;
          if (!drag) return;
          if (
            drag.mode === "pending" &&
            Math.abs(x - drag.startX) > TAP_SLOP_PX
          ) {
            drag.mode = "pan";
            setPanning(true);
          }
          if (drag.mode === "pan") {
            panTo(drag, x);
            return;
          }
          if (drag.mode === "scrub" && scrubbing) scrubTo(event);
        }}
        onPointerUp={(event) => {
          pointersRef.current.delete(event.pointerId);
          if (pointersRef.current.size < 2) pinchDistRef.current = null;
          if (pointersRef.current.size > 0) return;
          const drag = dragRef.current;
          dragRef.current = null;
          if (drag?.mode === "pending") {
            // A zoomed tap: a one-shot seek (same contract as a scrub, so
            // a parked replay still wakes to preview the moment).
            onScrubStart();
            scrubTo(event);
            onScrubEnd();
          }
          if (drag?.mode === "pan") setPanning(false);
          if (scrubbing) {
            setScrubbing(false);
            onScrubEnd();
          }
        }}
        onPointerCancel={(event) => {
          pointersRef.current.delete(event.pointerId);
          if (pointersRef.current.size < 2) pinchDistRef.current = null;
          if (pointersRef.current.size > 0) return;
          dragRef.current = null;
          if (panning) setPanning(false);
          if (scrubbing) {
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
            className={styles.svg}
            viewBox={`0 0 ${width} ${HEIGHT}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path className={styles.area} d={paths.area} />
            <path className={styles.outline} d={paths.outline} />
          </svg>
        )}
        {playhead && (
          <div
            ref={playheadRef}
            className={styles.playhead}
            data-testid="barogram-playhead"
            aria-hidden="true"
          />
        )}
        {kept && width >= 2 && (
          <>
            {/* The regions the brackets cut away: grayscaled (the profile
                loses its cyan under them) and dimmed. */}
            <div
              className={styles.cut}
              aria-hidden="true"
              style={{ left: 0, width: `${xFor(kept.startMs)}px` }}
            />
            <div
              className={styles.cut}
              aria-hidden="true"
              style={{ left: `${xFor(kept.endMs)}px`, right: 0 }}
            />
            {/* The yellow frame joining the two brackets around the kept
                window (the iOS-Photos trim idiom). */}
            <div
              className={styles.kept}
              aria-hidden="true"
              style={{
                left: `${xFor(kept.startMs)}px`,
                width: `${xFor(kept.endMs) - xFor(kept.startMs)}px`,
              }}
            />
          </>
        )}
        {mark && width >= 2 && mark.value >= w0 && mark.value <= w1 && (
          <div
            className={cx(styles.mark, styles[mark.kind])}
            data-testid={`clip-mark-${mark.kind}`}
            aria-hidden="true"
            style={{ transform: `translateX(${xFor(mark.value)}px)` }}
          >
            <div className={styles.grip} />
          </div>
        )}
        {cursorVisible && (
          <div
            className={styles.cursor}
            data-testid="timeline-cursor"
            style={{ transform: `translateX(${xFor(simTime)}px)` }}
            onPointerDown={(event) => {
              // Grabbing must not jump the value; the first MOVE scrubs.
              event.stopPropagation();
              event.currentTarget.setPointerCapture(event.pointerId);
              setScrubbing(true);
              onScrubStart();
            }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId))
                return;
              event.stopPropagation();
              scrubTo(event);
            }}
            onPointerUp={(event) => {
              event.stopPropagation();
              if (!event.currentTarget.hasPointerCapture(event.pointerId))
                return;
              setScrubbing(false);
              onScrubEnd();
            }}
            onPointerCancel={(event) => {
              event.stopPropagation();
              if (!event.currentTarget.hasPointerCapture(event.pointerId))
                return;
              setScrubbing(false);
              onScrubEnd();
            }}
          />
        )}
        <div
          ref={bubbleRef}
          className={cx(styles.bubble, scrubbing && styles.visible)}
          aria-hidden="true"
        />
        {timeWindow && (
          <button
            className={styles.reset}
            aria-label="Show whole flight"
            data-testid="timeline-reset"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => setTimeWindow(null)}
          >
            <NativeIcon icon={contractOutline} />
          </button>
        )}
      </div>
      {/* Which slice of the flight the zoomed graph shows. ALWAYS in the
          layout (hidden unzoomed): appearing on zoom grew the pane and
          made the map above jump. */}
      <div
        className={cx(styles.overview, timeWindow && styles.zoomed)}
        data-testid="barogram-overview"
        aria-hidden="true"
      >
        {timeWindow && (
          <div
            className={styles.window}
            data-testid="barogram-overview-window"
            style={{
              left: `${(((w0 - t0) / spanMs) * 100).toFixed(2)}%`,
              width: `${((wspan / spanMs) * 100).toFixed(2)}%`,
            }}
          />
        )}
      </div>
    </div>
  );
}
