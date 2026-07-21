import type { Annotation, Coordinate, PolylineOverlay } from "apple-mapkit";
import type { Feature } from "geojson";

import type { MapAppearance, MapViewKind } from "../config";
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
import { ACCENT_CYAN } from "../types";
import { loadMapKit } from "./loader";

import "./mapkit.css";

const REVEAL_FALLBACK_MS = 4000;
const ZERO_INSETS: Insets = { top: 0, bottom: 0, left: 0, right: 0 };

// MapKit rotation is opposite-signed to MapLibre bearing (verified on device:
// +1 turned the world — and the glyph — the wrong way in track-up).
const ROTATION_SIGN = -1;
const bearingToRotation = (bearing: number) =>
  normalizeDeg(ROTATION_SIGN * bearing);
const rotationToBearing = (rotation: number) =>
  normalizeDeg(ROTATION_SIGN * rotation);

function normalizeDeg(d: number) {
  return ((d % 360) + 360) % 360;
}

// Signed smallest rotation in (-180, 180].
function shortestAngle(d: number) {
  return ((((d + 180) % 360) + 360) % 360) - 180;
}

// The aircraft glyph — a blue chevron. Positioned by a 0×0 wrapper at the
// coordinate; the inner SVG centers itself and rotates to the screen heading.
const AIRCRAFT_SVG = `<svg width="48" height="48" viewBox="-24 -24 48 48" style="position:absolute;left:0;top:0;transform-origin:center"><polygon points="0,-20 14,16 0,8 -14,16" fill="${ACCENT_CYAN}" stroke="#0b2230" stroke-width="2" stroke-linejoin="round"/></svg>`;

interface MapKitEvent {
  coordinate?: Coordinate;
  pointOnPage?: { x: number; y: number };
}
interface EventTargetLike {
  addEventListener(type: string, listener: (e: MapKitEvent) => void): void;
  removeEventListener(type: string, listener: (e: MapKitEvent) => void): void;
}

function baseToMapType(base: MapViewKind) {
  return base === "satellite"
    ? mapkit.MapType.Hybrid
    : mapkit.MapType.MutedStandard;
}

function featuresOf(
  geometry: LngLat[] | Feature[],
): { coords: LngLat[]; color?: string }[] {
  if (geometry.length === 0) return [];
  if (Array.isArray(geometry[0])) return [{ coords: geometry as LngLat[] }];
  return (geometry as Feature[]).flatMap((feature) => {
    if (feature.geometry.type !== "LineString") return [];
    const color = (feature.properties as { color?: string } | null)?.color;
    return [{ coords: feature.geometry.coordinates as LngLat[], color }];
  });
}

const toCoord = (p: LngLat) => new mapkit.Coordinate(p[1], p[0]);

// The slivers of MapKit's private implementation that moveTo's atomic camera
// path touches (see the impl capture in createMapKitMapView). Member names
// are original source names — Apple's build minifies locals, not class
// members — but still private: every access must stay optional so a future
// restructure degrades to the public fallback instead of throwing.
interface PrivateCamera {
  zoom: number;
  center: unknown;
  copy(): PrivateCamera;
}
interface PrivateMapImpl {
  camera?: PrivateCamera;
  _visibleMapRect?: unknown;
  _mapNode?: {
    cameraAnimation?: { cancel(): void } | null;
    cameraAnimationDidEnd?(): void;
  };
  setCameraAnimated?(camera: PrivateCamera, animated: boolean): void;
  _offsetCenterWithPaddingAndRotation?(
    point: unknown,
    direction: number,
  ): unknown;
}

function measureSafeAreaBottom(): number {
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;bottom:0;height:env(safe-area-inset-bottom);visibility:hidden";
  document.body.appendChild(probe);
  const px = probe.getBoundingClientRect().height;
  probe.remove();
  return px;
}

export async function createMapKitMapView(
  container: HTMLElement,
  initialBase: MapViewKind,
  appearance: MapAppearance,
): Promise<MapView> {
  await loadMapKit();

  const map = new mapkit.Map(container, {
    showsCompass: mapkit.FeatureVisibility.Hidden,
    showsScale: mapkit.FeatureVisibility.Hidden,
    showsZoomControl: false,
    showsMapTypeControl: false,
    isRotationEnabled: true,
    mapType: baseToMapType(initialBase),
    center: new mapkit.Coordinate(39.8, -98.5),
  });
  // Ground screens ride dark like the rest of the app; the live flight
  // map is always light (sunlight-readable, STEERING).
  map.colorScheme =
    appearance === "light" ? mapkit.ColorScheme.Light : mapkit.ColorScheme.Dark;

  // The bearing the app last asked for. The glyph is oriented against this
  // (heading − lastBearing → 0 in track-up), so it holds pointing up.
  let lastBearing = 0;

  // mapkit.Map hides its real implementation behind a Symbol-keyed accessor:
  // map._(key) type-checks the key, then returns the impl from a WeakMap
  // keyed on the map alone. The key leaks through one wrapped call, and the
  // impl unlocks the one move the public API cannot express — an ATOMIC
  // animated camera set (moveTo). Null when the surface doesn't match, so
  // callers fall back to public setters.
  const impl = ((): PrivateMapImpl | null => {
    const proto = Object.getPrototypeOf(map) as {
      _?: (key: unknown) => unknown;
    };
    const accessor = proto._;
    if (typeof accessor !== "function") return null;
    let key: unknown;
    proto._ = function (k: unknown) {
      key = k;
      return accessor.call(this, k);
    };
    try {
      void map.center;
    } finally {
      proto._ = accessor;
    }
    try {
      return key !== undefined
        ? ((accessor.call(map, key) ?? null) as PrivateMapImpl | null)
        : null;
    } catch {
      return null;
    }
  })();

  // The camera-bearing debug hook the other adapters expose (maplibre stashes
  // its whole map) — so tests and manual driving can observe rotation here too.
  (container as HTMLElement & { __map?: { getBearing(): number } }).__map = {
    getBearing: () => rotationToBearing(map.rotation),
  };

  const emap = map as unknown as EventTargetLike;

  function eventAt(e: MapKitEvent): LngLat {
    if (e.coordinate) return [e.coordinate.longitude, e.coordinate.latitude];
    if (e.pointOnPage) {
      const c = map.convertPointOnPageToCoordinate(
        new DOMPoint(e.pointOnPage.x, e.pointOnPage.y),
      );
      return [c.longitude, c.latitude];
    }
    return [map.center.longitude, map.center.latitude];
  }

  function width() {
    return container.clientWidth || 390;
  }
  // Zoom from the live projection, NOT region.span or a calibrated
  // cameraDistance constant — both are unreliable (a programmatic
  // cameraDistance set leaves region.span stale/continental, and the
  // distance↔zoom constant can't be calibrated against that stale span).
  // Projected longitude is linear in Web Mercator, so pixels-per-degree maps
  // straight to the app's 256-tile zoom, matching the ZoomControl's bounds.
  // Null when the projection is degenerate (pre-layout, hidden container):
  // a made-up number folded into camera-delta math would land the camera at
  // an absolute wrong zoom, so callers must skip zoom work instead.
  function projectedZoom(): number | null {
    const c = map.center;
    const p0 = map.convertCoordinateToPointOnPage(
      new mapkit.Coordinate(c.latitude, c.longitude),
    );
    const p1 = map.convertCoordinateToPointOnPage(
      new mapkit.Coordinate(c.latitude, c.longitude + 0.02),
    );
    const dpx = Math.abs(p1.x - p0.x);
    if (!Number.isFinite(dpx) || dpx < 1e-6) return null;
    return Math.log2((360 * dpx) / (256 * 0.02));
  }

  // MapKit force-locks rotation below zoom 7 (its camera constraint
  // re-derives isRotationLocked from the zoom on every change): a twist
  // there rubber-bands to ±30° and snaps back to north on release, which
  // reads as a glitch, not a rule. Keep the rotate GESTURE off entirely
  // while the camera is in the locked range, so the map never teases a
  // rotation it won't keep. Programmatic rotation (track-up, the compass
  // tap) is a separate surface and stays untouched. Boundary verified
  // empirically: a twist at projectedZoom 6.9 snaps back, 7.05 sticks —
  // MapKit's internal zoom is the same 256-tile web-mercator scale.
  const ROTATION_UNLOCK_ZOOM = 7;
  function syncRotationGesture() {
    const zoom = projectedZoom();
    if (zoom === null) return;
    const enabled = zoom >= ROTATION_UNLOCK_ZOOM;
    if (map.isRotationEnabled !== enabled) map.isRotationEnabled = enabled;
  }
  syncRotationGesture();
  emap.addEventListener("zoom-end", syncRotationGesture);
  emap.addEventListener("region-change-end", syncRotationGesture);

  // Animated center+zoom as ONE camera tween, via the captured impl. The
  // public API can't express it: MapKit runs a single camera animation, and
  // an *animated* zoom issued during an in-flight pan is applied instantly
  // then overwritten by the pan's next frame — the locate button's old
  // pans-on-tap-1, zooms-on-tap-2 symptom. The internal setCameraAnimated
  // tweens one camera carrying center+zoom+rotation, so rotation survives
  // (only the region APIs hard-zero it). Zoom moves by delta so the
  // camera's native level scale never needs calibrating, and mid-tween the
  // delta self-corrects (projectedZoom reads the live mid-animation state
  // the copied camera starts from). False = the private surface didn't
  // carry the move (missing member, degenerate delta, or a throw); the
  // caller falls back to public setters.
  function atomicPanZoom(center: LngLat, delta: number): boolean {
    const camera = impl?.camera;
    const point = (
      toCoord(center) as Coordinate & { toMapPoint?(): unknown }
    ).toMapPoint?.();
    if (
      !impl?.setCameraAnimated ||
      !camera?.copy ||
      point === undefined ||
      !Number.isFinite(delta)
    ) {
      return false;
    }
    try {
      const target = camera.copy();
      target.center =
        impl._offsetCenterWithPaddingAndRotation?.(point, -1) || point;
      target.zoom += delta;
      if (!Number.isFinite(target.zoom)) return false;
      // A still-running tween would instant-apply-and-stomp this move
      // (MapKit's in-flight branch), so retire it first — through MapKit's
      // OWN end path. cancel() only stops the ticking, and hand-nulling
      // node.cameraAnimation skips the stop bookkeeping DidEnd performs
      // (cameraDidStopRotating et al): cancelling a rotating tween that way
      // leaves _rotating latched and region-change-end starved forever.
      const node = impl._mapNode;
      if (node?.cameraAnimation) {
        if (!node.cameraAnimationDidEnd) return false;
        node.cameraAnimation.cancel();
        node.cameraAnimationDidEnd();
      }
      delete impl._visibleMapRect;
      impl.setCameraAnimated(target, true);
      return true;
    } catch {
      return false;
    }
  }

  const view: MapView = {
    el: container,
    ready: new Promise<void>((resolve) => {
      emap.addEventListener("region-change-end", function once() {
        emap.removeEventListener("region-change-end", once);
        resolve();
      });
      setTimeout(resolve, REVEAL_FALLBACK_MS);
    }),
    supportsSatellite: true,

    setBaseMap(base) {
      map.mapType = baseToMapType(base);
    },

    // The Apple logo + Legal link are a license surface; inset them off the
    // home indicator only when the page places this map edge-to-edge (bottom
    // really under the indicator). Embedded maps pass false, so the controls
    // never float into a gap. measureSafeAreaBottom is 0 with no safe area
    // (desktop, older devices), which zeroes the padding too.
    setEdgeToEdge(edge) {
      map.padding = new mapkit.Padding(
        0,
        0,
        edge ? measureSafeAreaBottom() : 0,
        0,
      );
    },

    destroy() {
      map.destroy();
    },

    camera(): Camera {
      return {
        center: [map.center.longitude, map.center.latitude],
        // Pre-layout the projection has no answer; 3 (the construction-time
        // continental view) is the least-wrong report.
        zoom: projectedZoom() ?? 3,
        bearing: rotationToBearing(map.rotation),
        padding: ZERO_INSETS,
      };
    },

    moveTo(to: Partial<Camera>, opts?: MoveOptions) {
      const animated = opts?.animate ? true : false;
      // to.padding is ignored: the overscan padding is a MapLibre
      // oversized-container trick and is degenerate on MapKit's normal view.
      // Animated center+zoom rides ONE internal camera tween — see
      // atomicPanZoom for the whole story.
      if (
        animated &&
        to.center &&
        to.zoom !== undefined &&
        to.bearing === undefined
      ) {
        const zoom = projectedZoom();
        const delta = zoom === null ? NaN : to.zoom - zoom;
        if (!atomicPanZoom(to.center, delta)) {
          // Private surface went missing (Apple restructured): ride the one
          // public composition path — a NON-animated zoom set during an
          // in-flight animation is folded into it (cameraAnimation
          // .additiveZoom). Degrades to an instant zoom when already
          // centered, since then no pan tween starts to fold into.
          const dist = map.cameraDistance * Math.pow(2, -delta);
          map.setCenterAnimated(toCoord(to.center), true);
          if (Number.isFinite(dist) && dist > 0) map.cameraDistance = dist;
        }
        return;
      }
      // Otherwise each axis independently, instantly (property, not
      // *Animated) when not animating: center preserves zoom + rotation,
      // cameraDistance preserves center + rotation. No per-frame region set
      // (that reset track-up to north and thrashed tiles).
      if (to.bearing !== undefined) {
        lastBearing = to.bearing;
        const rotation = bearingToRotation(to.bearing);
        // Skip when already at (or turning to) the target — otherwise a
        // steady heading would re-trigger a native turn every fix.
        if (Math.abs(shortestAngle(rotation - map.rotation)) > 0.05) {
          map.setRotationAnimated(rotation, animated);
        }
      }
      if (to.center) {
        if (animated) map.setCenterAnimated(toCoord(to.center), true);
        else map.center = toCoord(to.center);
      }
      if (to.zoom !== undefined) {
        // Relative zoom: scale cameraDistance by the zoom delta. No absolute
        // calibration — MapKit's region↔distance mapping is unreliable, but
        // cameraDistance is linear in the visible scale, so a ratio is exact.
        const zoom = projectedZoom();
        const dist =
          zoom === null
            ? NaN
            : map.cameraDistance * Math.pow(2, zoom - to.zoom);
        if (Number.isFinite(dist) && dist > 0) {
          if (animated) map.setCameraDistanceAnimated(dist, true);
          else map.cameraDistance = dist;
        }
      }
    },

    fitBounds(bounds: Bounds, opts) {
      const [sw, ne] = bounds;
      const region = new mapkit.BoundingRegion(
        ne[1],
        ne[0],
        sw[1],
        sw[0],
      ).toCoordinateRegion();
      const pad = opts?.padding;
      if (pad) {
        const inset =
          typeof pad === "number"
            ? { top: pad, right: pad, bottom: pad, left: pad }
            : pad;
        const { w, h } = { w: width(), h: container.clientHeight || 779 };
        region.span.longitudeDelta /= Math.max(
          0.1,
          1 - (inset.left + inset.right) / w,
        );
        region.span.latitudeDelta /= Math.max(
          0.1,
          1 - (inset.top + inset.bottom) / h,
        );
        // Scaling the span zooms out around the UNTOUCHED center, which is
        // only half of padding: an asymmetric inset must also MOVE the
        // center, or a right-heavy inset (the seat's stats card) leaves
        // the track centered under the very thing the padding reserved
        // room for. Offset = half the imbalance, in degrees at the new
        // spans (longitude grows rightward, latitude grows upward while
        // pixel y grows downward, hence the signs).
        region.center = new mapkit.Coordinate(
          region.center.latitude -
            ((inset.bottom - inset.top) / 2) * (region.span.latitudeDelta / h),
          region.center.longitude +
            ((inset.right - inset.left) / 2) * (region.span.longitudeDelta / w),
        );
      }
      map.setRegionAnimated(region, false);
    },

    zoomRange() {
      return { min: 2, max: 20 };
    },

    // While following, the app owns zoom (the wheel is intercepted and applied
    // centered). Disable MapKit's native zoom gestures so a cursor-anchored
    // pinch can't drift the aircraft off-center.
    lockZoomAnchor(anchor) {
      map.isZoomEnabled = anchor !== "center";
    },

    line(style: LineStyle): Line {
      let overlays: PolylineOverlay[] = [];
      const solid = typeof style.color === "string" ? style.color : ACCENT_CYAN;
      const styleFor = (color: string) =>
        new mapkit.Style({
          lineWidth: style.width,
          strokeColor: color,
          lineJoin: "round",
          lineCap: "round",
          ...(style.dash ? { lineDash: style.dash } : {}),
          ...(style.opacity !== undefined
            ? { strokeOpacity: style.opacity }
            : {}),
        });
      return {
        set(geometry) {
          const feats = featuresOf(geometry).filter((f) => f.coords.length > 0);
          if (feats.length === overlays.length && overlays.length > 0) {
            // The flown line grows and is re-set every fix — reuse the overlay
            // (just its points) instead of tearing it down and re-adding it.
            feats.forEach((f, i) => {
              overlays[i].points = f.coords.map(toCoord);
            });
          } else {
            for (const o of overlays) map.removeOverlay(o);
            overlays = feats.map((f) => {
              const overlay = new mapkit.PolylineOverlay(
                f.coords.map(toCoord),
                {
                  style: styleFor(f.color ?? solid),
                },
              );
              map.addOverlay(overlay);
              return overlay;
            });
          }
          if (style.testId && overlays.length > 0) {
            container.setAttribute(`data-${style.testId}-layer`, "true");
          }
        },
        remove() {
          for (const o of overlays) map.removeOverlay(o);
          overlays = [];
        },
      };
    },

    markers(): MarkerLayer {
      // Keyed by spec.id. A re-set that only renumbers / nudges pure display
      // pins — the live route markers renumbering after a "skip" — updates
      // them IN PLACE (coordinate + glyph), instead of remove-then-re-add,
      // which flashes every pin off for a beat on device. Interactive pins
      // (Plan: tap-to-delete, drag, custom handles) are always recreated so
      // their handler closures can never go stale.
      let entries = new Map<string, { ann: Annotation; reusable: boolean }>();

      // Only plain balloons — no click/drag/custom behavior — can be reused;
      // everything else is torn down and rebuilt exactly as before.
      const isInteractive = (spec: MarkerSpec) =>
        !!(
          spec.onClick ||
          spec.onDrag ||
          spec.onDragEnd ||
          spec.draggable ||
          spec.custom
        );

      const create = (spec: MarkerSpec): Annotation => {
        const role = spec.color ?? ACCENT_CYAN;
        // A "custom" marker (the midpoint handle) renders its own small DOM
        // element instead of a native pin balloon, which reads too heavy.
        let ann: Annotation;
        if (spec.custom) {
          // Centered on the coordinate the same proven way as the aircraft
          // glyph: the element is a 0×0 wrapper — so its bottom-center, where
          // MapKit anchors at offset (0,0), IS the point — holding an inner
          // node translated −50%/−50% onto that origin. All the positioning
          // lives in the element's CSS; no anchorOffset math.
          ann = new mapkit.Annotation(toCoord(spec.at), () => spec.el, {
            draggable: spec.draggable ?? false,
            anchorOffset: new DOMPoint(0, 0),
          });
        } else {
          ann = new mapkit.MarkerAnnotation(toCoord(spec.at), {
            color: role,
            // Pure-black glyph on the bright green/blue balloon — max contrast
            // for a number a pilot reads at a glance in full sun (STEERING:
            // "Sunlight-readable. High contrast"). Endpoints override to white.
            glyphColor: spec.glyphColor ?? "#000000",
            // The pin's number (route order), shown in the balloon.
            ...(spec.label ? { glyphText: spec.label } : {}),
            calloutEnabled: false,
            animates: false,
            draggable: spec.draggable ?? false,
          });
        }
        const target = ann as unknown as EventTargetLike;
        if (spec.onClick) {
          const onClick = spec.onClick;
          target.addEventListener("select", () => {
            // Drop the selection so it doesn't linger while React re-sets the
            // annotation list, then act.
            map.selectedAnnotation = null;
            onClick();
          });
        }
        if (spec.onSelect) {
          const onSelect = spec.onSelect;
          // Tap-to-SELECT: let MapKit's native selection stand (the pin grows
          // and stays) — that IS the highlight — and just report it.
          target.addEventListener("select", () => onSelect());
        }
        if (spec.onDeselect) {
          const onDeselect = spec.onDeselect;
          target.addEventListener("deselect", () => onDeselect());
        }
        if (spec.draggable) {
          // The annotation's own coordinate tracks the drag; read it on each
          // move (live line redraw) and on release (commit).
          const at = (): LngLat => [
            ann.coordinate.longitude,
            ann.coordinate.latitude,
          ];
          if (spec.onDrag) {
            const onDrag = spec.onDrag;
            target.addEventListener("dragging", () => onDrag(at()));
          }
          if (spec.onDragEnd) {
            const onDragEnd = spec.onDragEnd;
            target.addEventListener("drag-end", () => onDragEnd(at()));
          }
        }
        map.addAnnotation(ann);
        return ann;
      };

      const clear = () => {
        for (const { ann } of entries.values()) map.removeAnnotation(ann);
        entries = new Map();
      };

      return {
        set(specs: MarkerSpec[]) {
          // A survivor = same id, both old and new are plain display pins.
          const reusedIds = new Set<string>();
          for (const spec of specs) {
            const existing = entries.get(spec.id);
            if (existing?.reusable && !isInteractive(spec)) {
              reusedIds.add(spec.id);
            }
          }
          // Remove every prior pin not surviving (gone, or being recreated).
          for (const [id, { ann }] of entries) {
            if (!reusedIds.has(id)) map.removeAnnotation(ann);
          }
          // Rebuild the id→ann map in spec order: update survivors in place,
          // create the rest.
          const next = new Map<
            string,
            { ann: Annotation; reusable: boolean }
          >();
          for (const spec of specs) {
            const existing = entries.get(spec.id);
            if (reusedIds.has(spec.id) && existing) {
              const marker = existing.ann as unknown as {
                coordinate: Coordinate;
                color: string;
                glyphText: string;
                glyphColor: string;
              };
              marker.coordinate = toCoord(spec.at);
              marker.color = spec.color ?? ACCENT_CYAN;
              marker.glyphText = spec.label ?? "";
              marker.glyphColor = spec.glyphColor ?? "#000000";
              next.set(spec.id, existing);
            } else {
              next.set(spec.id, {
                ann: create(spec),
                reusable: !isInteractive(spec),
              });
            }
          }
          entries = next;
        },
        clear,
      };
    },

    aircraft(): Aircraft {
      // Just the triangle now — the flown line (a Line) reaches the aircraft,
      // so there's no separate tail. A 0×0 wrapper sits at the coordinate; the
      // inner SVG centers itself and snaps to the on-screen heading.
      const wrapper = document.createElement("div");
      wrapper.style.width = "0";
      wrapper.style.height = "0";
      wrapper.innerHTML = AIRCRAFT_SVG;
      const svg = wrapper.firstElementChild as SVGElement;
      let ann: Annotation | null = null;
      container.setAttribute("data-aircraft-layer", "true");
      return {
        set(state: AircraftState | null) {
          if (!state) {
            if (ann) map.removeAnnotation(ann);
            ann = null;
            return;
          }
          const coord = toCoord(state.at);
          if (!ann) {
            ann = new mapkit.Annotation(coord, () => wrapper, {
              anchorOffset: new DOMPoint(0, 0),
            });
            map.addAnnotation(ann);
          } else {
            ann.coordinate = coord;
          }
          // Screen-fixed glyph, snapped (no animation): it points to the
          // on-screen heading — geographic course minus the map's target
          // bearing (0 in track-up, so it holds pointing up as the camera
          // turns under it).
          const screenAngle = state.heading - lastBearing;
          svg.style.transform = `translate(-50%, -50%) rotate(${screenAngle}deg)`;
        },
        remove() {
          if (ann) map.removeAnnotation(ann);
          ann = null;
        },
      };
    },

    on(gesture: Gesture, handler: (e: GestureEvent) => void): Unsub {
      // Pointer-level gestures (interaction begin/end, wheel hijack) come off
      // the DOM element; map-level ones off MapKit's own events.
      if (gesture === "down" || gesture === "up" || gesture === "wheel") {
        const el = container;
        if (gesture === "wheel") {
          const listener = (e: WheelEvent) =>
            handler({
              at: [map.center.longitude, map.center.latitude],
              deltaY: e.deltaY,
              ctrlKey: e.ctrlKey,
              preventDefault: () => e.preventDefault(),
            });
          el.addEventListener("wheel", listener, { passive: false });
          return () => el.removeEventListener("wheel", listener);
        }
        const domType = gesture === "down" ? "pointerdown" : "pointerup";
        const listener = () =>
          handler({ at: [map.center.longitude, map.center.latitude] });
        el.addEventListener(domType, listener);
        if (gesture === "up") el.addEventListener("pointercancel", listener);
        return () => {
          el.removeEventListener(domType, listener);
          el.removeEventListener("pointercancel", listener);
        };
      }
      if (gesture === "rotate") {
        // MapKit has no continuous rotation event (and whether its
        // rotation-start/end fire for a programmatic setRotationAnimated is
        // undocumented), so watch map.rotation per-frame and fire only when
        // it moved. The loop exists only while a subscriber does — pages
        // without a compass (and the live map, which never subscribes) pay
        // nothing.
        let last = map.rotation;
        let raf = requestAnimationFrame(function poll() {
          if (map.rotation !== last) {
            last = map.rotation;
            handler({ at: [map.center.longitude, map.center.latitude] });
          }
          raf = requestAnimationFrame(poll);
        });
        return () => cancelAnimationFrame(raf);
      }
      const type = {
        longpress: "long-press",
        dragstart: "scroll-start",
        dragend: "scroll-end",
        // Zoom-specific, not region-change: following re-centers the map every
        // fix, which would otherwise fire "zoom" (re-rendering the ZoomControl)
        // on every pan.
        zoom: "zoom-end",
        zoomend: "zoom-end",
      }[gesture];
      const listener = (e: MapKitEvent) => handler({ at: eventAt(e) });
      emap.addEventListener(type, listener);
      return () => emap.removeEventListener(type, listener);
    },
  };

  return view;
}
