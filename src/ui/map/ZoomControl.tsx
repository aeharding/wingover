import type { Map as MapLibreMap } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";

import "./ZoomControl.css";

// A forgiving one-thumb zoom control: touch ANYWHERE in the (wide) zone
// and drag — up zooms in, down zooms out — relative to where the drag
// began. No thumb to hit, no absolute position to land on precisely;
// dragging the control's full height covers the full range, and you can
// re-grab anywhere to keep going. The rail + dot only indicate the
// current zoom; they are not the touch target.
//
// Bounds are ground spans, not tile-stack limits: fully out ~20 mi across
// the screen, fully in ~0.35 mi. Derived from the VISIBLE viewport width
// (not the map container, which is inset by the render overscan and would
// otherwise understate the span by ~half).
const WIDEST_SPAN_M = 32_187; // ~20 mi across the screen
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
  const dragRef = useRef<{ startY: number; startZoom: number; height: number } | null>(
    null,
  );
  const [bounds, setBounds] = useState(() => spanBounds(map));
  const [zoom, setZoom] = useState(() => map.getZoom());

  useEffect(() => {
    const sync = () => {
      setBounds(spanBounds(map));
      setZoom(map.getZoom());
    };
    sync();
    // Zoom only: the dot tracks zoom, and latitude drift (which nudges the
    // span-derived bounds) is imperceptible between zooms. A "move"
    // listener would re-render this every follow-loop frame for nothing.
    map.on("zoom", sync);
    return () => {
      map.off("zoom", sync);
    };
  }, [map]);

  // 0 = fully out (dot at the bottom), 1 = fully in (dot at the top).
  const fraction = Math.min(
    1,
    Math.max(0, (zoom - bounds.min) / (bounds.max - bounds.min)),
  );

  return (
    <div
      className="zoom-control"
      role="slider"
      aria-label="Zoom"
      aria-orientation="vertical"
      aria-valuemin={Number(bounds.min.toFixed(2))}
      aria-valuemax={Number(bounds.max.toFixed(2))}
      aria-valuenow={Number(zoom.toFixed(2))}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = {
          startY: event.clientY,
          startZoom: map.getZoom(),
          height: event.currentTarget.clientHeight,
        };
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag) return;
        const { min, max } = spanBounds(map);
        // Up (clientY decreasing) zooms in; full height spans the range.
        const delta = ((drag.startY - event.clientY) / drag.height) * (max - min);
        onInput(Math.min(max, Math.max(min, drag.startZoom + delta)));
      }}
      onPointerUp={() => {
        dragRef.current = null;
      }}
      onPointerCancel={() => {
        dragRef.current = null;
      }}
    >
      <span className="zoom-control-cap" aria-hidden="true">
        +
      </span>
      <div className="zoom-control-rail">
        <div
          className="zoom-control-dot"
          style={{ top: `${(1 - fraction) * 100}%` }}
        />
      </div>
      <span className="zoom-control-cap" aria-hidden="true">
        −
      </span>
    </div>
  );
}
