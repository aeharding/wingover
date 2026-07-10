import type { Map as MapLibreMap } from "maplibre-gl";
import { useEffect, useEffectEvent, useRef, useState } from "react";

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
const ATTRIBUTION_LINGER_MS = 6000;
const REVEAL_FALLBACK_MS = 4000;

let attributionShownThisLaunch = false;
let attributionLingerElapsed = false;

export default function MapView({ view, onReady, onLongPress }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const notifyReady = useEffectEvent((map: MapLibreMap, lib: MapLibreModule) =>
    onReady?.(map, lib),
  );
  const notifyLongPress = useEffectEvent(
    (point: { longitude: number; latitude: number }) => onLongPress?.(point),
  );
  const initialViewRef = useRef(view);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let map: MapLibreMap | undefined;
    let attributionObserver: MutationObserver | undefined;
    const reveal = () => {
      if (!cancelled) setRevealed(true);
    };
    const revealFallback = setTimeout(reveal, REVEAL_FALLBACK_MS);

    (async () => {
      const lib = await import("maplibre-gl");
      const style = await resolveMapStyle(initialViewRef.current);
      if (cancelled || !containerRef.current) return;
      map = new lib.Map({
        container: containerRef.current,
        style,
        center: [-98.5, 39.8],
        zoom: 3,
        fadeDuration: 0,
        attributionControl: false,
      });
      map.addControl(
        new lib.AttributionControl({ compact: true }),
        "bottom-left",
      );
      const attribution = containerRef.current.querySelector(
        ".maplibregl-ctrl-attrib",
      ) as HTMLDetailsElement | null;
      if (attribution) {
        const collapse = () => {
          attribution.open = false;
        };
        if (attributionShownThisLaunch) {
          collapse();
        } else {
          attributionShownThisLaunch = true;
          setTimeout(() => {
            attributionLingerElapsed = true;
            collapse();
          }, ATTRIBUTION_LINGER_MS);
        }

        let userToggleAt = 0;
        attribution.querySelector("summary")?.addEventListener("click", () => {
          userToggleAt = Date.now();
        });
        attributionObserver = new MutationObserver(() => {
          if (!attributionLingerElapsed) return;
          if (attribution.open && Date.now() - userToggleAt > 400) collapse();
        });
        attributionObserver.observe(attribution, {
          attributes: true,
          attributeFilter: ["open"],
        });
      }
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
          notifyLongPress({
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

      notifyReady(map, lib);
    })();

    return () => {
      cancelled = true;
      clearTimeout(revealFallback);
      attributionObserver?.disconnect();
      map?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    (async () => {
      const style = await resolveMapStyle(view);
      mapRef.current?.setStyle(style);
    })();
  }, [view]);

  // Modifier classes go through classList: maplibre adds its own classes
  // to this container, and a React className write would clobber them.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.classList.toggle("satellite", view === "satellite");
    container.classList.toggle("map-loading", !revealed);
  }, [view, revealed]);

  return <div ref={containerRef} className="map-container" />;
}
