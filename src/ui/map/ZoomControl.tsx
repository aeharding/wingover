import { useEffect, useRef, useState } from "react";

import type { MapView } from "./types";

import "./ZoomControl.css";

// Zoom lives on the very right EDGE of the screen: press anywhere along the
// edge and slide — down zooms in, up zooms out — relative to where the drag
// began (down = "pull the ground toward you"). No thumb to hit, no absolute
// track to land on; re-grab anywhere to keep going. The right edge is
// deliberate: iOS system swipes live on the LEFT (back) and BOTTOM (home)
// edges, never the right, so nothing fights this gesture. Leaving the map
// clear also frees it for two-finger pinch.
//
// A short gauge — a thumb on a rail down the very edge — floats between the
// stats and the buttons. It is HIDDEN at rest and appears only while you
// drag: the thumb shows how zoomed you are (top of the rail = fully out,
// bottom = fully in). The touch zone is far taller than the gauge, so you
// can grab the edge well above or below it. Nothing is on screen when you
// are just flying.
//
// Sensitivity is a fixed screen distance (not the gauge's height): a full
// zoom sweep takes DRAG_RANGE_PX of travel wherever you grab.
const DRAG_RANGE_PX = 280;

// Bounds are ground spans, not tile-stack limits: fully out ~30 mi across
// the screen, fully in ~0.35 mi. Derived from the VISIBLE viewport width
// (not the map container, which is inset by the render overscan and would
// otherwise understate the span by ~half).
const WIDEST_SPAN_M = 48_280; // ~30 mi across the screen
const TIGHTEST_SPAN_M = 563; // ~0.35 mi
const MERCATOR_M_PER_PX_Z0 = 156_543.033_92;

function zoomForSpan(latDeg: number, widthPx: number, spanM: number): number {
  const lat = (latDeg * Math.PI) / 180;
  return Math.log2((MERCATOR_M_PER_PX_Z0 * Math.cos(lat) * widthPx) / spanM);
}

function spanBounds(map: MapView): { min: number; max: number } {
  const widthPx = (typeof window !== "undefined" && window.innerWidth) || 390;
  const latitude = map.camera().center[1];
  return {
    min: zoomForSpan(latitude, widthPx, WIDEST_SPAN_M),
    max: zoomForSpan(latitude, widthPx, TIGHTEST_SPAN_M),
  };
}

// 0 = fully out (thumb at the top cap), 1 = fully in (bottom cap) — matches
// down-to-zoom-in.
function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

interface ZoomControlProps {
  map: MapView;
  onInput: (zoom: number) => void;
}

export default function ZoomControl({ map, onInput }: ZoomControlProps) {
  const dragRef = useRef<{
    startY: number;
    min: number;
    max: number;
    startFraction: number;
  } | null>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  const [bounds, setBounds] = useState(() => spanBounds(map));
  const [zoom, setZoom] = useState(() => map.camera().zoom);

  // The thumb's position is written straight to the DOM — never through React
  // state — so during a drag it tracks the finger with zero render lag.
  function placeThumb(fraction: number) {
    if (thumbRef.current) {
      thumbRef.current.style.top = `${clamp01(fraction) * 100}%`;
    }
  }

  useEffect(() => {
    const sync = () => {
      const b = spanBounds(map);
      setBounds(b);
      const z = map.camera().zoom;
      setZoom(z);
      // Park the (hidden) thumb at the live zoom when not dragging; the drag
      // owns it imperatively.
      if (!dragRef.current) placeThumb((z - b.min) / (b.max - b.min));
    };
    sync();
    // Zoom only: latitude drift (which nudges the span-derived bounds) is
    // imperceptible between zooms, and a "move" listener would re-render
    // this every fix for nothing.
    return map.on("zoom", sync);
  }, [map]);

  return (
    <div
      className={active ? "zoom-strip active" : "zoom-strip"}
      role="slider"
      aria-label="Zoom"
      aria-orientation="vertical"
      aria-valuemin={Number(bounds.min.toFixed(2))}
      aria-valuemax={Number(bounds.max.toFixed(2))}
      aria-valuenow={Number(zoom.toFixed(2))}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        // Snapshot the starting fraction + bounds; the drag is a pure px→
        // fraction offset from here, so the thumb never re-derives from the
        // (laggy) zoom value.
        const { min, max } = spanBounds(map);
        const startFraction = (map.camera().zoom - min) / (max - min);
        dragRef.current = { startY: event.clientY, min, max, startFraction };
        setActive(true);
        placeThumb(startFraction);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag) return;
        // Down (clientY increasing) zooms in; a full sweep takes DRAG_RANGE_PX
        // of travel regardless of where the strip is grabbed.
        const fraction = clamp01(
          drag.startFraction + (event.clientY - drag.startY) / DRAG_RANGE_PX,
        );
        placeThumb(fraction); // imperative → no lag
        const next = drag.min + fraction * (drag.max - drag.min);
        onInput(next);
        setZoom(next); // aria only; does not drive the thumb
      }}
      onPointerUp={() => {
        dragRef.current = null;
        setActive(false);
      }}
      onPointerCancel={() => {
        dragRef.current = null;
        setActive(false);
      }}
    >
      {/* The gauge: hidden until touched. A rounded triangle rides the rail,
          pointing at the current zoom — top of the rail is fully out, bottom
          fully in. */}
      <div className="zoom-gauge" aria-hidden="true">
        <div className="zoom-gauge-rail">
          <div className="zoom-gauge-thumb" ref={thumbRef}>
            <svg viewBox="0 0 66 100" aria-hidden="true">
              <path d="M18 12 L52 50 L18 88 Z" />
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}
