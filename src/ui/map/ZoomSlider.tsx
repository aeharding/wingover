import type { Map as MapLibreMap } from "maplibre-gl";
import { useEffect, useRef } from "react";

import "./ZoomSlider.css";

// Pinch needs two hands (one is on the throttle/brakes): a chunky vertical
// slider gives one-thumb zoom. Usability over looks — big hit area, no
// chrome. The thumb tracks the map's real zoom, so pinch/wheel and the
// slider never disagree.
const MIN_ZOOM_FLOOR = 3;
const KEY_STEP = 0.5;

interface ZoomSliderProps {
  map: MapLibreMap;
  onInput: (zoom: number) => void;
}

export default function ZoomSlider({ map, onInput }: ZoomSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  function minZoom() {
    return Math.max(map.getMinZoom(), MIN_ZOOM_FLOOR);
  }

  useEffect(() => {
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!track || !thumb) return;
    const sync = () => {
      const min = Math.max(map.getMinZoom(), MIN_ZOOM_FLOOR);
      const max = map.getMaxZoom();
      const fraction = Math.min(
        1,
        Math.max(0, (map.getZoom() - min) / (max - min)),
      );
      thumb.style.top = `${(1 - fraction) * 100}%`;
      track.setAttribute("aria-valuenow", map.getZoom().toFixed(1));
    };
    sync();
    map.on("zoom", sync);
    return () => {
      map.off("zoom", sync);
    };
  }, [map]);

  function zoomAt(clientY: number) {
    const track = trackRef.current;
    if (!track) return map.getZoom();
    const rect = track.getBoundingClientRect();
    const fraction = Math.min(
      1,
      Math.max(0, 1 - (clientY - rect.top) / rect.height),
    );
    return minZoom() + fraction * (map.getMaxZoom() - minZoom());
  }

  return (
    <div
      ref={trackRef}
      className="zoom-slider"
      role="slider"
      tabIndex={0}
      aria-label="Zoom"
      aria-orientation="vertical"
      aria-valuemin={minZoom()}
      aria-valuemax={map.getMaxZoom()}
      aria-valuenow={Number(map.getZoom().toFixed(1))}
      onPointerDown={(event) => {
        draggingRef.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        onInput(zoomAt(event.clientY));
      }}
      onPointerMove={(event) => {
        if (draggingRef.current) onInput(zoomAt(event.clientY));
      }}
      onPointerUp={() => {
        draggingRef.current = false;
      }}
      onPointerCancel={() => {
        draggingRef.current = false;
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowUp") onInput(map.getZoom() + KEY_STEP);
        if (event.key === "ArrowDown") onInput(map.getZoom() - KEY_STEP);
      }}
    >
      <span className="zoom-slider-cap" aria-hidden="true">
        +
      </span>
      <div ref={thumbRef} className="zoom-slider-thumb" />
      <span className="zoom-slider-cap zoom-slider-cap-bottom" aria-hidden="true">
        −
      </span>
    </div>
  );
}
