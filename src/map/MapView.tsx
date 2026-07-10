import type { AttributionControl, Map as MapLibreMap } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";

import { type MapViewKind, resolveMapStyle } from "./config";

import "maplibre-gl/dist/maplibre-gl.css";
import "./MapView.css";

export type MapLibreModule = typeof import("maplibre-gl");

interface MapViewProps {
  view: MapViewKind;
  onReady?: (map: MapLibreMap, lib: MapLibreModule) => void;
  onLongPress?: (point: { longitude: number; latitude: number }) => void;
}

const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE_PX = 10;
const REVEAL_FALLBACK_MS = 4000;

export default function MapView({ view, onReady, onLongPress }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onLongPressRef = useRef(onLongPress);
  onLongPressRef.current = onLongPress;
  const initialViewRef = useRef(view);
  const [revealed, setRevealed] = useState(false);

  // OSM attribution lives on the Settings page. The on-map control exists
  // only for satellite view, where MapTiler's terms require on-map credit.
  const attributionRef = useRef<AttributionControl | null>(null);
  const libRef = useRef<MapLibreModule | null>(null);

  function syncAttribution(map: MapLibreMap, current: MapViewKind) {
    const lib = libRef.current;
    if (!lib) return;
    if (current === "satellite" && !attributionRef.current) {
      attributionRef.current = new lib.AttributionControl({ compact: true });
      map.addControl(attributionRef.current, "bottom-left");
      const attribution = map
        .getContainer()
        .querySelector(".maplibregl-ctrl-attrib") as HTMLDetailsElement | null;
      if (attribution) attribution.open = false;
    } else if (current !== "satellite" && attributionRef.current) {
      map.removeControl(attributionRef.current);
      attributionRef.current = null;
    }
  }

  useEffect(() => {
    let cancelled = false;
    let map: MapLibreMap | undefined;
    const reveal = () => {
      if (!cancelled) setRevealed(true);
    };
    const revealFallback = setTimeout(reveal, REVEAL_FALLBACK_MS);

    (async () => {
      const lib = await import("maplibre-gl");
      const style = await resolveMapStyle(initialViewRef.current);
      if (cancelled || !containerRef.current) return;
      libRef.current = lib;
      map = new lib.Map({
        container: containerRef.current,
        style,
        center: [-98.5, 39.8],
        zoom: 3,
        fadeDuration: 0,
        attributionControl: false,
      });
      syncAttribution(map, initialViewRef.current);
      mapRef.current = map;
      (containerRef.current as HTMLDivElement & { __map?: MapLibreMap }).__map =
        map;

      let pressTimer: ReturnType<typeof setTimeout> | undefined;
      let pressPoint: { x: number; y: number } | null = null;

      const cancelPress = () => {
        clearTimeout(pressTimer);
        pressTimer = undefined;
        pressPoint = null;
      };

      const beginPress = (
        point: { x: number; y: number },
        lngLat: { lng: number; lat: number },
      ) => {
        cancelPress();
        pressPoint = point;
        pressTimer = setTimeout(() => {
          cancelPress();
          onLongPressRef.current?.({
            longitude: lngLat.lng,
            latitude: lngLat.lat,
          });
        }, LONG_PRESS_MS);
      };

      const trackMove = (point: { x: number; y: number }) => {
        if (!pressPoint) return;
        const distance = Math.hypot(
          point.x - pressPoint.x,
          point.y - pressPoint.y,
        );
        if (distance > MOVE_TOLERANCE_PX) cancelPress();
      };

      map.on("mousedown", (event) => beginPress(event.point, event.lngLat));
      map.on("touchstart", (event) => {
        if (event.points.length === 1) beginPress(event.point, event.lngLat);
        else cancelPress();
      });
      map.on("mousemove", (event) => trackMove(event.point));
      map.on("touchmove", (event) => trackMove(event.point));
      map.on("mouseup", cancelPress);
      map.on("touchend", cancelPress);
      map.on("touchcancel", cancelPress);
      map.on("dragstart", cancelPress);
      map.on("zoomstart", cancelPress);
      map.on("rotatestart", cancelPress);
      map.on("pitchstart", cancelPress);

      map.once("load", reveal);

      onReadyRef.current?.(map, lib);
    })();

    return () => {
      cancelled = true;
      clearTimeout(revealFallback);
      attributionRef.current = null;
      map?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    (async () => {
      const style = await resolveMapStyle(view);
      const map = mapRef.current;
      if (!map) return;
      map.setStyle(style);
      syncAttribution(map, view);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  const classes = [
    "map-container",
    view === "satellite" ? "satellite" : undefined,
    revealed ? undefined : "map-loading",
  ]
    .filter(Boolean)
    .join(" ");

  return <div ref={containerRef} className={classes} />;
}
