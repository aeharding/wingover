import type { Feature, FeatureCollection } from "geojson";
import { AttributionControl, Map as MapLibreMap, Marker } from "maplibre-gl";
import type { GeoJSONSource, MapMouseEvent } from "maplibre-gl";

import {
  type MapAppearance,
  type MapViewKind,
  resolveMapStyle,
  resolveMaptilerKey,
} from "../config";
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
  MoveOptions,
  Unsub,
} from "../types";
import { createAircraftLayer } from "./aircraft";

const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE_PX = 10;
const ATTRIBUTION_LINGER_MS = 6000;
const REVEAL_FALLBACK_MS = 4000;

// One-per-launch attribution reveal: the MapTiler credit expands the first
// time the app shows a map, lingers, then collapses and stays collapsed.
let attributionShownThisLaunch = false;
let attributionLingerElapsed = false;

const ZERO_INSETS: Insets = { top: 0, bottom: 0, left: 0, right: 0 };

interface LineRecord {
  sourceId: string;
  layerId: string;
  style: LineStyle;
  data: FeatureCollection;
  attrMarked: boolean;
}

// A LngLat is a [number, number] pair; a Feature is an object. Discriminate
// on the first element: a coordinate array → one polyline; features → as-is.
function toFeatureCollection(
  geometry: LngLat[] | Feature[],
): FeatureCollection {
  if (geometry.length === 0) return { type: "FeatureCollection", features: [] };
  if (Array.isArray(geometry[0])) {
    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: geometry as LngLat[] },
        },
      ],
    };
  }
  return { type: "FeatureCollection", features: geometry as Feature[] };
}

export async function createMapLibreMapView(
  container: HTMLElement,
  initialBase: MapViewKind,
  appearance: MapAppearance,
): Promise<MapView> {
  const style = await resolveMapStyle(initialBase, appearance);
  // Decided once at creation: satellite here costs MapTiler quota, so it
  // exists only on the pilot's own key. A key added in Settings takes
  // effect on the next map, which is fine — Settings has no map.
  const supportsSatellite = !!(await resolveMaptilerKey());
  const map = new MapLibreMap({
    container,
    style,
    center: [-98.5, 39.8],
    zoom: 3,
    fadeDuration: 0,
    attributionControl: false,
  });
  map.addControl(new AttributionControl({ compact: true }), "bottom-left");
  (container as HTMLElement & { __map?: MapLibreMap }).__map = map;

  setupAttribution(container);

  // ── content registry (survives setBaseMap) ───────────────────────────

  /**
   * maplibre's style parser predates CSS Color 4: hex/rgb/hsl only. A
   * color() function is rejected as an error EVENT, not a throw, so the
   * layer silently never appears — measured: the track line was invisible
   * on every maplibre map while MapKit, whose overlays are CSS, drew the
   * same constant fine (and the readiness attribute still got set, so the
   * e2e attribute check passed over the missing line). Colors stay
   * authored in display-p3 (STEERING); this maps them into sRGB at the
   * one boundary that cannot go wider, through the real linear-light
   * matrix, so the hue survives even where the gamut clamps.
   */
  function toSrgb(color: string | ["get", string]): string | ["get", string] {
    if (typeof color !== "string") return color;
    const m =
      /^color\(display-p3\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+))?\)$/.exec(
        color,
      );
    if (!m) return color;
    const linear = (c: number) =>
      c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    const delinear = (c: number) =>
      c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
    const [r, g, b] = [+m[1]!, +m[2]!, +m[3]!].map(linear);
    const channel = (v: number) =>
      Math.round(Math.min(1, Math.max(0, delinear(v))) * 255);
    const rs = channel(1.2249402 * r - 0.2249402 * g);
    const gs = channel(-0.0420569 * r + 1.0420569 * g);
    const bs = channel(-0.0196376 * r - 0.0786361 * g + 1.0982735 * b);
    return `rgba(${rs}, ${gs}, ${bs}, ${m[4] ?? 1})`;
  }
  const lines: LineRecord[] = [];
  let aircraftState: AircraftState | null = null;
  let aircraftRegistered = false;
  let nextLineId = 0;

  // Re-create any registered source/layer that a style (re)load tore down.
  // Idempotent and independent per item: a mid-flight setStyle drops every
  // runtime-added layer, and the aircraft custom layer must be restored on
  // its own even when a geojson line source outlived it.
  function sync() {
    if (!map.isStyleLoaded()) return;
    for (const rec of lines) {
      if (!map.getSource(rec.sourceId)) {
        map.addSource(rec.sourceId, { type: "geojson", data: rec.data });
      }
      if (!map.getLayer(rec.layerId)) {
        map.addLayer({
          id: rec.layerId,
          type: "line",
          source: rec.sourceId,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": toSrgb(rec.style.color),
            "line-width": rec.style.width,
            ...(rec.style.dash ? { "line-dasharray": rec.style.dash } : {}),
            ...(rec.style.opacity !== undefined
              ? { "line-opacity": rec.style.opacity }
              : {}),
          },
        });
      }
      if (rec.style.testId && !rec.attrMarked) {
        container.setAttribute(`data-${rec.style.testId}-layer`, "true");
        rec.attrMarked = true;
      }
    }
    if (aircraftRegistered && !map.getLayer("aircraft")) {
      map.addLayer(createAircraftLayer(() => aircraftState));
      container.setAttribute("data-aircraft-layer", "true");
    }
  }

  map.on("style.load", sync);
  map.on("styledata", sync);
  map.on("idle", sync);

  // ── gesture fan-out ───────────────────────────────────────────────────
  const longPressHandlers = new Set<(e: GestureEvent) => void>();

  setupLongPress(map, (at) => {
    for (const handler of longPressHandlers) handler({ at });
  });

  function eventAt(e?: { lngLat?: { lng: number; lat: number } }): LngLat {
    const ll = e?.lngLat;
    if (ll) return [ll.lng, ll.lat];
    const c = map.getCenter();
    return [c.lng, c.lat];
  }

  function onNative(types: string[], listener: (e: unknown) => void): Unsub {
    for (const type of types) map.on(type as "mousedown", listener);
    return () => {
      for (const type of types) map.off(type as "mousedown", listener);
    };
  }

  const view: MapView = {
    el: container,
    ready: new Promise<void>((resolve) => {
      map.once("load", () => resolve());
      setTimeout(resolve, REVEAL_FALLBACK_MS);
    }),
    supportsSatellite,

    // MapLibre's attribution is CSS-positioned; its safe-area lives in
    // MapView.css, so there is nothing to set on the map itself.
    setEdgeToEdge() {},
    setBaseMap(base) {
      void resolveMapStyle(base, appearance).then((next) => map.setStyle(next));
    },

    destroy() {
      map.remove();
    },

    camera(): Camera {
      const c = map.getCenter();
      return {
        center: [c.lng, c.lat],
        zoom: map.getZoom(),
        bearing: map.getBearing(),
        padding: ZERO_INSETS,
      };
    },

    moveTo(to: Partial<Camera>, opts?: MoveOptions) {
      const options: Record<string, unknown> = {};
      if (to.center) options.center = to.center;
      if (to.zoom !== undefined) options.zoom = to.zoom;
      if (to.bearing !== undefined) options.bearing = to.bearing;
      if (to.padding) options.padding = to.padding;
      const animate = opts?.animate;
      if (!animate) map.jumpTo(options);
      else if (animate === "fly") map.flyTo(options);
      else map.easeTo(options);
    },

    fitBounds(bounds: Bounds, opts) {
      map.fitBounds(bounds, { padding: opts?.padding, animate: false });
    },

    zoomRange() {
      return { min: map.getMinZoom(), max: map.getMaxZoom() };
    },

    lockZoomAnchor(anchor) {
      const options =
        anchor === "center" ? { around: "center" as const } : undefined;
      map.scrollZoom.enable(options);
      map.touchZoomRotate.enable(options);
    },

    line(style: LineStyle): Line {
      // A testId gives the source/layer a stable, meaningful id (and an
      // e2e readiness attribute); otherwise the id is auto-generated.
      const id = style.testId ?? `line-${nextLineId++}`;
      const rec: LineRecord = {
        sourceId: id,
        layerId: id,
        style,
        data: { type: "FeatureCollection", features: [] },
        attrMarked: false,
      };
      lines.push(rec);
      sync();
      return {
        set(geometry) {
          rec.data = toFeatureCollection(geometry);
          const source = map.getSource(rec.sourceId) as
            GeoJSONSource | undefined;
          if (source) source.setData(rec.data);
          else sync();
        },
        remove() {
          if (map.getLayer(rec.layerId)) map.removeLayer(rec.layerId);
          if (map.getSource(rec.sourceId)) map.removeSource(rec.sourceId);
          const index = lines.indexOf(rec);
          if (index >= 0) lines.splice(index, 1);
        },
      };
    },

    markers(): MarkerLayer {
      const current = new Map<string, Marker>();
      function clear() {
        for (const marker of current.values()) marker.remove();
        current.clear();
      }
      return {
        set(specs: MarkerSpec[]) {
          clear();
          for (const spec of specs) {
            if (spec.onClick) {
              const onClick = spec.onClick;
              spec.el.addEventListener("click", (event) => {
                event.stopPropagation();
                onClick();
              });
            }
            if (spec.onSelect) {
              // No native marker selection in maplibre — a tap reports the
              // selection; the app tracks it and deselect rides reselect/remove.
              const onSelect = spec.onSelect;
              spec.el.addEventListener("click", (event) => {
                event.stopPropagation();
                onSelect();
              });
            }
            const marker = new Marker({
              element: spec.el,
              anchor: spec.anchor ?? "center",
              draggable: spec.draggable ?? false,
            })
              .setLngLat(spec.at)
              .addTo(map);
            if (spec.draggable) {
              const at = (): LngLat => {
                const ll = marker.getLngLat();
                return [ll.lng, ll.lat];
              };
              if (spec.onDrag) {
                const onDrag = spec.onDrag;
                marker.on("drag", () => onDrag(at()));
              }
              if (spec.onDragEnd) {
                const onDragEnd = spec.onDragEnd;
                marker.on("dragend", () => onDragEnd(at()));
              }
            }
            current.set(spec.id, marker);
          }
        },
        clear,
      };
    },

    aircraft(): Aircraft {
      aircraftRegistered = true;
      sync();
      return {
        set(state: AircraftState | null) {
          aircraftState = state;
          if (state) {
            (
              container as HTMLElement & {
                __display?: { lng: number; lat: number; course: number };
              }
            ).__display = {
              lng: state.at[0],
              lat: state.at[1],
              course: state.heading,
            };
          }
          map.triggerRepaint();
        },
        remove() {
          aircraftRegistered = false;
          aircraftState = null;
          if (map.getLayer("aircraft")) map.removeLayer("aircraft");
        },
      };
    },

    on(gesture: Gesture, handler: (e: GestureEvent) => void): Unsub {
      switch (gesture) {
        case "longpress":
          longPressHandlers.add(handler);
          return () => longPressHandlers.delete(handler);
        case "down":
          return onNative(["mousedown", "touchstart"], (e) =>
            handler({ at: eventAt(e as MapMouseEvent) }),
          );
        case "up":
          return onNative(["mouseup", "touchend", "touchcancel"], (e) =>
            handler({ at: eventAt(e as MapMouseEvent) }),
          );
        case "dragstart":
          return onNative(["dragstart"], (e) =>
            handler({ at: eventAt(e as MapMouseEvent) }),
          );
        case "dragend":
          return onNative(["dragend"], (e) =>
            handler({ at: eventAt(e as MapMouseEvent) }),
          );
        case "zoom":
          return onNative(["zoom"], (e) =>
            handler({ at: eventAt(e as MapMouseEvent) }),
          );
        case "zoomend":
          return onNative(["zoomend"], (e) =>
            handler({ at: eventAt(e as MapMouseEvent) }),
          );
        case "wheel":
          return onNative(["wheel"], (e) => {
            const event = e as MapMouseEvent & {
              originalEvent: WheelEvent;
              preventDefault: () => void;
            };
            const original = event.originalEvent;
            handler({
              at: eventAt(event),
              deltaY: original.deltaY,
              ctrlKey: original.ctrlKey,
              preventDefault: () => event.preventDefault(),
            });
          });
      }
    },
  };

  return view;
}

// A press held in place (no drag past MOVE_TOLERANCE_PX, single touch) for
// LONG_PRESS_MS resolves to a geographic point; any pan/zoom/rotate cancels.
function setupLongPress(map: MapLibreMap, fire: (at: LngLat) => void) {
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
      fire([lngLat.lng, lngLat.lat]);
    }, LONG_PRESS_MS);
  };

  const trackMove = (point: { x: number; y: number }) => {
    if (!pressPoint) return;
    const distance = Math.hypot(point.x - pressPoint.x, point.y - pressPoint.y);
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
}

function setupAttribution(container: HTMLElement) {
  const attribution = container.querySelector(
    ".maplibregl-ctrl-attrib",
  ) as HTMLDetailsElement | null;
  if (!attribution) return;

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
  const observer = new MutationObserver(() => {
    if (!attributionLingerElapsed) return;
    if (attribution.open && Date.now() - userToggleAt > 400) collapse();
  });
  observer.observe(attribution, {
    attributes: true,
    attributeFilter: ["open"],
  });
}
