import { useEffect, useEffectEvent, useRef, useState } from "react";

import { onSettingChanged } from "../../storage/local";
import {
  type MapAppearance,
  type MapViewKind,
  resolveBackend,
} from "./config";
import type { MapView } from "./types";

// maplibre-gl.css must load before MapView.css: both style the shared
// container (`.maplibregl-map` vs `.map-container`) with equal specificity,
// so ours must come last to win (position: absolute; inset: 0). Eager, and
// ahead of MapView.css — the adapter (and its map JS) still load lazily.
import "maplibre-gl/dist/maplibre-gl.css";
import "./MapView.css";

interface MapCanvasProps {
  base: MapViewKind;
  // Dark is the default world (matches the app); the live flight map passes
  // "light" — full sun is where the dark basemap loses (STEERING).
  appearance?: MapAppearance;
  // The page owns the map's layout, so it says whether the map is placed
  // edge-to-edge (a full-screen or in-flight map, whose bottom sits under the
  // home indicator) — then MapKit insets its Apple/Legal controls off the
  // indicator. Embedded maps (logbook, plan, the desktop panes) leave it false;
  // the inset would only float those controls into a gap.
  edgeToEdge?: boolean;
  // null = the previous view was just destroyed (provider re-create,
  // unmount). Parents MUST drop their MapView and every handle minted from
  // it — a 1 Hz fix calling line.set() on a removed map throws, and with no
  // error boundary that unmounts the whole app mid-flight.
  onReady?: (view: MapView | null) => void;
}

// Instantiate the resolved backend, each in its own lazy chunk. MapKit is the
// default; if it can't load or authorize (offline, blocked, wrong origin) fall
// back to MapLibre so a map always appears. The fake backend is network-free
// and used by the e2e suite.
async function createBackend(
  container: HTMLElement,
  base: MapViewKind,
  appearance: MapAppearance,
  edgeToEdge: boolean,
): Promise<MapView> {
  const backend = await resolveBackend();
  if (backend === "fake") {
    const { createFakeMapView } = await import("./fake/adapter");
    return createFakeMapView(container);
  }
  if (backend === "mapkit") {
    try {
      const { createMapKitMapView } = await import("./mapkit/adapter");
      return await createMapKitMapView(container, base, appearance, edgeToEdge);
    } catch (error) {
      console.warn("MapKit unavailable; falling back to MapLibre", error);
    }
  }
  const { createMapLibreMapView } = await import("./maplibre/adapter");
  return createMapLibreMapView(container, base, appearance);
}

// The React host for a map. It owns the `.map-container` div and the backend
// lifecycle, handing the abstract MapView to its parent via onReady — the one
// place any concrete backend (maplibre/adapter, later a mapkit one) is named.
// The maplibre adapter is dynamically imported so maplibre-gl stays in a lazy
// chunk that loads only when a map is first shown.
export default function MapCanvas({
  base,
  appearance = "dark",
  edgeToEdge = false,
  onReady,
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<MapView | null>(null);
  const [revealed, setRevealed] = useState(false);
  // Bumped when the pilot changes the map provider in Settings: the whole
  // backend is torn down and re-created in place, so the choice applies
  // immediately — tab pages stay mounted forever and would otherwise show
  // the old provider until relaunch. Consumers already rebuild their
  // content on every onReady, so a new view flows through like the first.
  const [epoch, setEpoch] = useState(0);
  const notifyReady = useEffectEvent((view: MapView | null) => onReady?.(view));
  const baseRef = useRef(base);

  // The key gates MapLibre satellite (supportsSatellite is decided at
  // creation), so key changes re-create too — debounced, because the key is
  // typed keystroke by keystroke in Settings.
  useEffect(() => {
    // Re-create = a fresh reveal: the loading veil covers the swap instead
    // of the old map vanishing to a naked container.
    const recreate = () => {
      setRevealed(false);
      setEpoch((n) => n + 1);
    };
    const offBackend = onSettingChanged("mapBackend", recreate);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const offKey = onSettingChanged("maptilerKey", () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(recreate, 800);
    });
    return () => {
      offBackend();
      offKey();
      if (timer) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let view: MapView | undefined;
    (async () => {
      if (!containerRef.current) return;
      const createdWith = baseRef.current;
      view = await createBackend(
        containerRef.current,
        createdWith,
        appearance,
        edgeToEdge,
      );
      if (cancelled) {
        view.destroy();
        return;
      }
      viewRef.current = view;
      // The base can move while createBackend is in flight (pages load the
      // persisted view async, and the base effect no-ops on a null
      // viewRef): a satellite pilot refreshing the page got a street map
      // under a satellite toggle. Apply the latest base the effect
      // recorded, only when it actually moved.
      if (baseRef.current !== createdWith) view.setBaseMap(baseRef.current);
      notifyReady(view);
      void view.ready.then(() => {
        if (!cancelled) setRevealed(true);
      });
    })();

    return () => {
      cancelled = true;
      view?.destroy();
      viewRef.current = null;
      // The parent's copy is now a landmine; take it away (see props).
      notifyReady(null);
    };
  }, [epoch, appearance, edgeToEdge]);

  useEffect(() => {
    baseRef.current = base;
    viewRef.current?.setBaseMap(base);
  }, [base]);

  // Modifier classes go through classList: maplibre writes its own classes to
  // this container, and a React className write would clobber them.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.classList.toggle("satellite", base === "satellite");
    container.classList.toggle("map-loading", !revealed);
    // The attribution (an OSM license obligation) is styled per appearance:
    // its dark-map colors are white-on-white over a light basemap.
    container.classList.toggle("map-light", appearance === "light");
  }, [base, revealed, appearance]);

  // A drag that starts on the map belongs to the map: without this, a pan
  // beginning near the left edge doubles as Ionic's swipe-back and navigates
  // away mid-gesture. The swipe-back gesture listens natively on the router
  // outlet, so it must be cut off natively here — React's delegated handlers
  // run long after the event has already bubbled through the outlet.
  // Scoped to the edge strip where swipe-back can start (canStart: x <= 50),
  // so document-level listeners (Ionic's focus-visible reset among them)
  // keep hearing everything else the map is touched with.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const stop = (event: TouchEvent | MouseEvent) => {
      const x =
        "touches" in event ? event.touches[0]?.clientX : event.clientX;
      if (x !== undefined && x <= 60) event.stopPropagation();
    };
    container.addEventListener("touchstart", stop);
    container.addEventListener("mousedown", stop);
    return () => {
      container.removeEventListener("touchstart", stop);
      container.removeEventListener("mousedown", stop);
    };
  }, []);

  return <div ref={containerRef} className="map-container" />;
}
