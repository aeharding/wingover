import type { Map as MapLibreMap } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";

import "./ZoomControl.css";

// Zoom lives on the very right EDGE of the screen: press anywhere along the
// edge and slide — down zooms in, up zooms out — relative to where the drag
// began (down = "pull the ground toward you"). No thumb to hit, no absolute
// track to land on; re-grab anywhere to keep going. There is no rail/dot
// widget — just a quiet grip hint so the edge is discoverable — which frees
// the whole map for two-finger pinch. The right edge is deliberate: iOS
// system swipes live on the LEFT (back) and BOTTOM (home) edges, never the
// right, so nothing fights this gesture.
//
// Sensitivity is a fixed screen distance (not the strip's height): a full
// zoom sweep takes DRAG_RANGE_PX of travel wherever you grab, so a tall
// touch zone stays as responsive as a short one.
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

function spanBounds(map: MapLibreMap): { min: number; max: number } {
  const widthPx = (typeof window !== "undefined" && window.innerWidth) || 390;
  const latitude = map.getCenter().lat;
  return {
    min: zoomForSpan(latitude, widthPx, WIDEST_SPAN_M),
    max: zoomForSpan(latitude, widthPx, TIGHTEST_SPAN_M),
  };
}

interface ZoomControlProps {
  map: MapLibreMap;
  onInput: (zoom: number) => void;
}

export default function ZoomControl({ map, onInput }: ZoomControlProps) {
  const dragRef = useRef<{ startY: number; startZoom: number } | null>(null);
  const [active, setActive] = useState(false);
  const [bounds, setBounds] = useState(() => spanBounds(map));
  const [zoom, setZoom] = useState(() => map.getZoom());

  useEffect(() => {
    const sync = () => {
      setBounds(spanBounds(map));
      setZoom(map.getZoom());
    };
    sync();
    // Zoom only: latitude drift (which nudges the span-derived bounds) is
    // imperceptible between zooms, and a "move" listener would re-render
    // this every follow-loop frame for nothing.
    map.on("zoom", sync);
    return () => {
      map.off("zoom", sync);
    };
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
        dragRef.current = { startY: event.clientY, startZoom: map.getZoom() };
        setActive(true);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag) return;
        const { min, max } = spanBounds(map);
        // Down (clientY increasing) zooms in; a full sweep takes
        // DRAG_RANGE_PX of travel regardless of where the strip is grabbed.
        const delta = ((event.clientY - drag.startY) / DRAG_RANGE_PX) * (max - min);
        const next = Math.min(max, Math.max(min, drag.startZoom + delta));
        onInput(next);
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
      {/* Quiet, static grip: the only affordance that says "grab this edge".
          It does not track the zoom (no widget to read) — it just brightens
          while dragging. */}
      <div className="zoom-strip-grip" aria-hidden="true" />
    </div>
  );
}
