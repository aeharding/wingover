import { useEffect, useEffectEvent, useRef, useState } from "react";

import { type MapViewKind, resolveBackend } from "./config";
import type { MapView } from "./types";

// maplibre-gl.css must load before MapView.css: both style the shared
// container (`.maplibregl-map` vs `.map-container`) with equal specificity,
// so ours must come last to win (position: absolute; inset: 0). Eager, and
// ahead of MapView.css — the adapter (and its map JS) still load lazily.
import "maplibre-gl/dist/maplibre-gl.css";
import "./MapView.css";

interface MapCanvasProps {
  base: MapViewKind;
  onReady?: (view: MapView) => void;
}

// Instantiate the resolved backend, each in its own lazy chunk. MapKit is the
// default; if it can't load or authorize (offline, blocked, wrong origin) fall
// back to MapLibre so a map always appears. The fake backend is network-free
// and used by the e2e suite.
async function createBackend(
  container: HTMLElement,
  base: MapViewKind,
): Promise<MapView> {
  const backend = resolveBackend();
  if (backend === "fake") {
    const { createFakeMapView } = await import("./fake/adapter");
    return createFakeMapView(container);
  }
  if (backend === "mapkit") {
    try {
      const { createMapKitMapView } = await import("./mapkit/adapter");
      return await createMapKitMapView(container, base);
    } catch (error) {
      console.warn("MapKit unavailable; falling back to MapLibre", error);
    }
  }
  const { createMapLibreMapView } = await import("./maplibre/adapter");
  return createMapLibreMapView(container, base);
}

// The React host for a map. It owns the `.map-container` div and the backend
// lifecycle, handing the abstract MapView to its parent via onReady — the one
// place any concrete backend (maplibre/adapter, later a mapkit one) is named.
// The maplibre adapter is dynamically imported so maplibre-gl stays in a lazy
// chunk that loads only when a map is first shown.
export default function MapCanvas({ base, onReady }: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<MapView | null>(null);
  const [revealed, setRevealed] = useState(false);
  const notifyReady = useEffectEvent((view: MapView) => onReady?.(view));
  const initialBaseRef = useRef(base);

  useEffect(() => {
    let cancelled = false;
    let view: MapView | undefined;
    (async () => {
      if (!containerRef.current) return;
      view = await createBackend(containerRef.current, initialBaseRef.current);
      if (cancelled) {
        view.destroy();
        return;
      }
      viewRef.current = view;
      notifyReady(view);
      void view.ready.then(() => {
        if (!cancelled) setRevealed(true);
      });
    })();

    return () => {
      cancelled = true;
      view?.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    viewRef.current?.setBaseMap(base);
  }, [base]);

  // Modifier classes go through classList: maplibre writes its own classes to
  // this container, and a React className write would clobber them.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.classList.toggle("satellite", base === "satellite");
    container.classList.toggle("map-loading", !revealed);
  }, [base, revealed]);

  // A drag that starts on the map belongs to the map: without this, a pan
  // beginning near the left edge doubles as Ionic's swipe-back and navigates
  // away mid-gesture. The swipe-back gesture listens natively on the router
  // outlet, so it must be cut off natively here — React's delegated handlers
  // run long after the event has already bubbled through the outlet.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const stop = (event: Event) => event.stopPropagation();
    container.addEventListener("touchstart", stop);
    container.addEventListener("mousedown", stop);
    return () => {
      container.removeEventListener("touchstart", stop);
      container.removeEventListener("mousedown", stop);
    };
  }, []);

  return <div ref={containerRef} className="map-container" />;
}
