import {
  type ReactNode,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import StyleObserver from "style-observer";

import { onSettingChanged } from "../../storage/local";
import { type MapAppearance, type MapViewKind, resolveBackend } from "./config";
import type { Insets, MapView } from "./types";

// maplibre-gl.css must load before MapView.css: both style the shared
// container (`.maplibregl-map` vs `.map-container`) with equal specificity,
// so ours must come last to win (position: absolute; inset: 0). Eager, and
// ahead of MapView.css — the adapter (and its map JS) still load lazily.
import "maplibre-gl/dist/maplibre-gl.css";
import mapCss from "./map.module.css";

interface MapCanvasProps {
  base: MapViewKind;
  // Required so every new map decides its world consciously: ground pages
  // pass the system scheme (useSystemAppearance) so the basemap matches
  // the app; the live flight map is pinned "light" — full sun is where a
  // dark basemap loses (STEERING).
  appearance: MapAppearance;
  // The map's overlay — buttons, pills, tap layers — rendered as CHILDREN
  // so they live inside the inset context the map owns (that shared
  // ownership is the whole point). Positioned in host CSS off the
  // cascading var(--ion-safe-area-*).
  children?: ReactNode;
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
): Promise<MapView> {
  const backend = await resolveBackend();
  if (backend === "fake") {
    const { createFakeMapView } = await import("./fake/adapter");
    return createFakeMapView(container);
  }
  if (backend === "mapkit") {
    try {
      const { createMapKitMapView } = await import("./mapkit/adapter");
      return await createMapKitMapView(container, base, appearance);
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
  appearance,
  children,
  onReady,
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<MapView | null>(null);
  const [revealed, setRevealed] = useState(false);
  // The JS<->CSS bridge for the backend attribution. The overlay, the
  // MapLibre attribution and every other chrome read var(--ion-safe-area-*)
  // directly (they cascade + consume in CSS); MapKit needs real px, so a
  // hidden probe INSIDE this map's subtree carries the same cascaded,
  // already-consumed --ion-safe-area-* as padding, and we read it back resolved.
  // One source (the vars), so the MapKit logo can't drift from the
  // CSS-positioned buttons.
  const probeRef = useRef<HTMLDivElement>(null);
  const insetsRef = useRef<Insets>({ top: 0, right: 0, bottom: 0, left: 0 });
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

  // The camera of the view a re-create tore down, carried to its
  // successor: an appearance flip (scheme change, satellite forcing
  // dark) or provider swap must not cost the pilot their place on the
  // map — the regression was every toggle snapping back to the fit.
  const preservedCameraRef = useRef<ReturnType<MapView["camera"]> | null>(null);
  const appearanceRef = useRef(appearance);

  useEffect(() => {
    // Captured once: the container node is stable across an epoch
    // re-create (React reuses the same div), and the cleanup reads it
    // (the ref-in-cleanup lint wants a local).
    const container = containerRef.current;
    let cancelled = false;
    let view: MapView | undefined;
    (async () => {
      if (!container) return;
      const createdWith = baseRef.current;
      const createdAppearance = appearanceRef.current;
      view = await createBackend(container, createdWith, createdAppearance);
      if (cancelled) {
        view.destroy();
        return;
      }
      viewRef.current = view;
      // Apply the current insets to the fresh map (and to one re-created
      // by a provider swap); the effect below keeps it in sync.
      view.setInsets(insetsRef.current);
      // Restore the predecessor's camera BEFORE anyone sees the view, and
      // mark it so pages skip their arrival refit (see MapView.types).
      const preserved = preservedCameraRef.current;
      if (preserved) {
        preservedCameraRef.current = null;
        view.moveTo(preserved, { animate: false });
        view.restoredCamera = true;
      }
      // The base and appearance can both move while createBackend is in
      // flight (pages load the persisted view async; the OS scheme can
      // cross its sunset switch, or a satellite toggle fire, during the
      // hundreds-of-ms load): the per-prop effects no-op on a null
      // viewRef, so re-apply the latest the effects recorded, only when
      // it actually moved. (Without the appearance line a map created
      // mid-flip baked in the stale scheme until the next change.)
      if (baseRef.current !== createdWith) view.setBaseMap(baseRef.current);
      if (appearanceRef.current !== createdAppearance)
        view.setAppearance(appearanceRef.current);
      notifyReady(view);
      void view.ready.then(() => {
        if (!cancelled) setRevealed(true);
      });
    })();

    return () => {
      cancelled = true;
      // Preserve the camera for the successor ONLY from a laid-out map —
      // a re-create fires on EVERY mounted instance, and the ones in
      // hidden tabs (a provider/key change comes from the Settings tab,
      // so the map tabs are display:none, 0×0) read a bogus camera:
      // MapKit derives zoom from the live projection, which collapses to
      // the continental fallback with no viewport. Skipping the hidden
      // capture leaves preservedCameraRef null, so the successor takes no
      // camera and the page reframes on next view — its pre-change
      // behavior, and the pilot was not looking at that tab anyway. A
      // visible re-create (the only one that would visibly snap) still
      // preserves. Backend-agnostic: MapLibre's stored zoom would have
      // survived a hidden read, but the rule stays about visibility, not
      // backend.
      if (view && (container?.clientWidth ?? 0) > 0) {
        preservedCameraRef.current = view.camera();
      }
      view?.destroy();
      viewRef.current = null;
      // The parent's copy is now a landmine; take it away (see props).
      notifyReady(null);
    };
  }, [epoch]);

  useEffect(() => {
    baseRef.current = base;
    viewRef.current?.setBaseMap(base);
  }, [base]);

  // Live appearance: the scheme flip (or satellite forcing dark) restyles
  // the EXISTING backend — MapKit's colorScheme and MapLibre's setStyle
  // are both in-place operations — so the pilot's camera never moves at
  // all. Re-creates are reserved for the provider/key paths above, where
  // the camera-preservation hand-off covers the gap.
  useEffect(() => {
    appearanceRef.current = appearance;
    viewRef.current?.setAppearance(appearance);
  }, [appearance]);

  // Resolve the map's own inset off the probe and push it to the backend.
  // The probe carries the cascaded, already-consumed var(--ion-safe-area-*) as
  // padding, so its resolved padding is the px really exposed at THIS
  // map's position — no prop drilling, no knowledge of who consumed what.
  const readInsets = useEffectEvent(() => {
    const probe = probeRef.current;
    if (!probe) return;
    const style = getComputedStyle(probe);
    insetsRef.current = {
      top: parseFloat(style.paddingTop) || 0,
      right: parseFloat(style.paddingRight) || 0,
      bottom: parseFloat(style.paddingBottom) || 0,
      left: parseFloat(style.paddingLeft) || 0,
    };
    viewRef.current?.setInsets(insetsRef.current);
  });

  // StyleObserver (Lea Verou) fires whenever the probe's resolved padding
  // moves, which is exactly when the exposed inset moves: device rotation
  // re-resolves env(), and a consume class toggling (the replay pane
  // opening, a fullscreen switch) changes a --ion-safe-area-* var. One
  // read + one observer covers every case; the initial read seeds it.
  // observe/unobserve take (target, properties) explicitly — the options-
  // object form leaves a single Element as `targets`, whose missing
  // `.length` silently skips the observe and throws on teardown.
  useEffect(() => {
    const probe = probeRef.current;
    if (!probe) return;
    readInsets();
    const props = [
      "padding-top",
      "padding-right",
      "padding-bottom",
      "padding-left",
    ];
    const observer = new StyleObserver(() => readInsets());
    observer.observe(probe, props);
    return () => observer.unobserve(probe, props);
  }, []);

  // Modifier classes go through classList: maplibre writes its own classes to
  // this container, and a React className write would clobber them.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.classList.toggle("satellite", base === "satellite");
    container.classList.toggle(mapCss.loading, !revealed);
    // The attribution (an OSM license obligation) is styled per appearance:
    // its dark-map colors are white-on-white over a light basemap.
    container.classList.toggle(mapCss.light, appearance === "light");
    container.setAttribute("data-appearance", appearance);
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
      const x = "touches" in event ? event.touches[0]?.clientX : event.clientX;
      if (x !== undefined && x <= 60) event.stopPropagation();
    };
    container.addEventListener("touchstart", stop);
    container.addEventListener("mousedown", stop);
    return () => {
      container.removeEventListener("touchstart", stop);
      container.removeEventListener("mousedown", stop);
    };
  }, []);

  // The surface fills the host's map box and wraps the backend container,
  // the inset probe, and the overlay children. The children position off
  // var(--ion-safe-area-*) (cascaded + consumed in CSS); the probe reads the same
  // vars for the MapKit path — one source, so the logo and the buttons
  // can't disagree.
  return (
    <div className={mapCss.surface}>
      <div
        ref={containerRef}
        className={mapCss.container}
        data-testid="map-container"
      />
      <div
        ref={probeRef}
        className={mapCss.insetProbe}
        data-testid="map-inset-probe"
        aria-hidden="true"
      />
      {children}
    </div>
  );
}
