import type {
  Aircraft,
  AircraftState,
  Bounds,
  Camera,
  Gesture,
  GestureEvent,
  Insets,
  Line,
  LineStyle,
  LngLat,
  MapView,
  MarkerLayer,
  MarkerSpec,
  Unsub,
} from "../types";

// A network-free, deterministic MapView with no real map — the backend the
// e2e suite runs against so app logic (follow camera, pins, track-up, the
// zoom control, edge guards) is tested without MapLibre or MapKit, their
// tiles, or their auth. It renders just enough real DOM (the marker elements
// the consumers build, a linear screen<->lnglat projection, the same debug
// hooks the MapLibre adapter exposes) for those tests to observe behavior.
// Real map rendering is verified separately, against a real backend.

const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE_PX = 10;
const TILE = 256;

const ZERO_INSETS: Insets = { top: 0, bottom: 0, left: 0, right: 0 };

export function createFakeMapView(container: HTMLElement): MapView {
  let center: LngLat = [-98.5, 39.8];
  let zoom = 3;
  let bearing = 0;

  // A `.map-container`-relative overlay the markers live in (position:
  // absolute), kept out of the way of the gesture surface (the container).
  const markerRoot = document.createElement("div");
  markerRoot.style.position = "absolute";
  markerRoot.style.inset = "0";
  markerRoot.style.pointerEvents = "none";
  container.appendChild(markerRoot);

  // The MapLibre adapter stashes the live map so e2e can read the camera
  // bearing after a track-up toggle; mirror the one method the tests use.
  (container as HTMLElement & { __map?: { getBearing(): number } }).__map = {
    getBearing: () => bearing,
  };

  function size() {
    return {
      w: container.clientWidth || 390,
      h: container.clientHeight || 779,
    };
  }

  // Linear, invertible screen<->geo mapping (bearing ignored — no gesture in
  // the tests rotates mid-press). Deterministic so a long-press at a screen
  // point always yields the same coordinate.
  function degPerPx() {
    return 360 / (TILE * Math.pow(2, zoom));
  }
  function unproject(x: number, y: number): LngLat {
    const { w, h } = size();
    const d = degPerPx();
    return [center[0] + (x - w / 2) * d, center[1] - (y - h / 2) * d];
  }
  function project(at: LngLat): { x: number; y: number } {
    const { w, h } = size();
    const d = degPerPx();
    return {
      x: w / 2 + (at[0] - center[0]) / d,
      y: h / 2 - (at[1] - center[1]) / d,
    };
  }

  // ── gesture fan-out ───────────────────────────────────────────────────
  const handlers: Record<Gesture, Set<(e: GestureEvent) => void>> = {
    longpress: new Set(),
    down: new Set(),
    up: new Set(),
    dragstart: new Set(),
    dragend: new Set(),
    zoom: new Set(),
    zoomend: new Set(),
    rotate: new Set(),
    wheel: new Set(),
  };
  function fire(gesture: Gesture, event: GestureEvent) {
    for (const handler of handlers[gesture]) handler(event);
  }
  const centerEvent = (): GestureEvent => ({ at: center });

  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  let pressAt: { x: number; y: number } | null = null;
  let dragging = false;

  function localPoint(e: PointerEvent) {
    const rect = container.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  const onPointerDown = (e: PointerEvent) => {
    const point = localPoint(e);
    pressAt = point;
    dragging = false;
    fire("down", centerEvent());
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      pressTimer = undefined;
      pressAt = null;
      fire("longpress", { at: unproject(point.x, point.y) });
    }, LONG_PRESS_MS);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!pressAt) return;
    const point = localPoint(e);
    const moved = Math.hypot(point.x - pressAt.x, point.y - pressAt.y);
    if (moved <= MOVE_TOLERANCE_PX) return;
    clearTimeout(pressTimer);
    pressTimer = undefined;
    if (!dragging) {
      dragging = true;
      fire("dragstart", centerEvent());
    }
  };
  const endPress = () => {
    clearTimeout(pressTimer);
    pressTimer = undefined;
    pressAt = null;
    fire("up", centerEvent());
    if (dragging) {
      dragging = false;
      fire("dragend", centerEvent());
    }
  };
  const onWheel = (e: WheelEvent) => {
    fire("wheel", {
      at: center,
      deltaY: e.deltaY,
      ctrlKey: e.ctrlKey,
      preventDefault: () => e.preventDefault(),
    });
  };

  container.addEventListener("pointerdown", onPointerDown);
  container.addEventListener("pointermove", onPointerMove);
  container.addEventListener("pointerup", endPress);
  container.addEventListener("pointercancel", endPress);
  container.addEventListener("wheel", onWheel, { passive: false });

  function repositionMarkers() {
    for (const marker of markers) marker.place();
  }

  interface FakeMarker {
    place(): void;
    remove(): void;
  }
  const markers = new Set<FakeMarker>();

  function setZoom(next: number) {
    if (next === zoom) return;
    zoom = next;
    fire("zoom", centerEvent());
    fire("zoomend", centerEvent());
  }

  const view: MapView = {
    el: container,
    ready: Promise.resolve(),
    supportsSatellite: true,
    setBaseMap() {},
    setInsets() {},
    destroy() {
      clearTimeout(pressTimer);
      container.removeEventListener("pointerdown", onPointerDown);
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerup", endPress);
      container.removeEventListener("pointercancel", endPress);
      container.removeEventListener("wheel", onWheel);
      markerRoot.remove();
    },

    camera(): Camera {
      return { center, zoom, bearing, padding: ZERO_INSETS };
    },

    moveTo(to: Partial<Camera>) {
      if (to.center) center = to.center;
      if (to.bearing !== undefined && to.bearing !== bearing) {
        bearing = to.bearing;
        fire("rotate", centerEvent());
      }
      if (to.zoom !== undefined) setZoom(to.zoom);
      repositionMarkers();
    },

    fitBounds(bounds: Bounds) {
      const [sw, ne] = bounds;
      // A bounds fit is north-up by construction on the real backends (the
      // fullscreen-collapse reset relies on it to dismiss the compass) —
      // keep the contract here too.
      if (bearing !== 0) {
        bearing = 0;
        fire("rotate", centerEvent());
      }
      center = [(sw[0] + ne[0]) / 2, (sw[1] + ne[1]) / 2];
      const { w } = size();
      const spanLng = Math.max(Math.abs(ne[0] - sw[0]), 1e-4);
      setZoom(Math.log2((360 * w) / (TILE * spanLng)));
      repositionMarkers();
    },

    setAppearance() {},

    zoomRange() {
      return { min: 2, max: 20 };
    },

    lockZoomAnchor() {},

    line(style: LineStyle): Line {
      return {
        set(geometry) {
          if (style.testId && geometry.length > 0) {
            container.setAttribute(`data-${style.testId}-layer`, "true");
          }
        },
        remove() {},
      };
    },

    markers(): MarkerLayer {
      const own = new Set<FakeMarker>();
      const clear = () => {
        for (const marker of own) marker.remove();
        own.clear();
      };
      return {
        set(specs: MarkerSpec[]) {
          clear();
          for (const spec of specs) {
            const el = spec.el;
            el.style.position = "absolute";
            el.style.pointerEvents = "auto";
            el.style.transform =
              spec.anchor === "bottom"
                ? "translate(-50%, -100%)"
                : "translate(-50%, -50%)";
            if (spec.onClick) {
              const onClick = spec.onClick;
              el.addEventListener("click", (event) => {
                event.stopPropagation();
                onClick();
              });
            }
            if (spec.onSelect) {
              const onSelect = spec.onSelect;
              el.addEventListener("click", (event) => {
                event.stopPropagation();
                onSelect();
              });
            }
            markerRoot.appendChild(el);
            const marker: FakeMarker = {
              place() {
                const p = project(spec.at);
                el.style.left = `${p.x}px`;
                el.style.top = `${p.y}px`;
              },
              remove() {
                el.remove();
                markers.delete(marker);
              },
            };
            marker.place();
            markers.add(marker);
            own.add(marker);
          }
        },
        clear,
      };
    },

    aircraft(): Aircraft {
      container.setAttribute("data-aircraft-layer", "true");
      return {
        set(state: AircraftState | null) {
          if (!state) return;
          (
            container as HTMLElement & {
              __display?: { lng: number; lat: number; course: number };
            }
          ).__display = {
            lng: state.at[0],
            lat: state.at[1],
            course: state.heading,
          };
        },
        remove() {},
      };
    },

    on(gesture: Gesture, handler: (e: GestureEvent) => void): Unsub {
      handlers[gesture].add(handler);
      return () => handlers[gesture].delete(handler);
    },
  };

  return view;
}
