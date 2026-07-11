import type { Map as MapLibreMap } from "maplibre-gl";
import { useEffect, useRef } from "react";

import "./ZoomSlider.css";

// One-thumb zoom (pinch needs two hands; a pilot has one), bounded by
// what is USEFUL in flight rather than what the tile stack allows: all
// the way out shows ~20 mi across the screen (the whole flight area),
// all the way in ~0.35 mi (a landing field and its approaches — crossed
// in ~45 s at PPG speeds; closer is clutter). Native <input type=range>:
// platform drag behavior, chunky accent styling, zero custom gesture code.
const WIDEST_SPAN_M = 32_187; // ~20 mi across the viewport
const TIGHTEST_SPAN_M = 560; // ~0.35 mi
const STEP = 0.05;

// Web mercator: meters per pixel at zoom z is C * cos(latitude) / 2^z.
const MERCATOR_M_PER_PX_Z0 = 156_543.033_92;

function zoomForSpan(map: MapLibreMap, spanM: number): number {
  const widthPx = map.getContainer().clientWidth || 390;
  const latitude = (map.getCenter().lat * Math.PI) / 180;
  return Math.log2(
    (MERCATOR_M_PER_PX_Z0 * Math.cos(latitude) * widthPx) / spanM,
  );
}

interface ZoomSliderProps {
  map: MapLibreMap;
  onInput: (zoom: number) => void;
}

export default function ZoomSlider({ map, onInput }: ZoomSliderProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // The thumb tracks the map's real zoom (pinch and slider never
  // disagree), and the span bounds re-derive as latitude/viewport change.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const sync = () => {
      input.min = zoomForSpan(map, WIDEST_SPAN_M).toFixed(2);
      input.max = zoomForSpan(map, TIGHTEST_SPAN_M).toFixed(2);
      input.value = map.getZoom().toFixed(2);
    };
    sync();
    map.on("zoom", sync);
    return () => {
      map.off("zoom", sync);
    };
  }, [map]);

  return (
    <input
      ref={inputRef}
      className="zoom-slider"
      type="range"
      aria-label="Zoom"
      min={zoomForSpan(map, WIDEST_SPAN_M).toFixed(2)}
      max={zoomForSpan(map, TIGHTEST_SPAN_M).toFixed(2)}
      step={STEP}
      defaultValue={map.getZoom().toFixed(2)}
      onInput={(event) => onInput(Number(event.currentTarget.value))}
    />
  );
}
