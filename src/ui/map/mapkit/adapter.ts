import type {
  Annotation,
  Coordinate,
  Padding,
  PolylineOverlay,
} from "apple-mapkit";
import type { Feature } from "geojson";

import { breadcrumb, registerDiagProbe } from "../../diag";
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

function samePadding(a: Padding, b: Padding) {
  return (
    a.top === b.top &&
    a.right === b.right &&
    a.bottom === b.bottom &&
    a.left === b.left
  );
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
interface PrivateMapPoint {
  x: number;
  y: number;
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
    point: PrivateMapPoint,
    direction: number,
  ): PrivateMapPoint | undefined;
  // The public `map.padding =` setter forwards here with no options; only
  // the impl takes the second argument (see writePaddingWithoutRect).
  setPadding?(
    padding: Padding,
    options: { updateVisibleMapRect: boolean },
  ): void;
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
  // #185 CANCEL PROBE (throwaway branch): the probe polls every live map's
  // center, so it has to know they exist.
  ((window as unknown as Record<string, unknown>).__wingoverMaps ??=
    new Set()) as Set<unknown>;
  (
    (window as unknown as Record<string, unknown>)
      .__wingoverMaps as Set<unknown>
  ).add(map);

  // MapKit's recognizers never unwind on a cancelled touch: `touchesCancelled`
  // is empty and `enterCancelledState()` is reachable only from the `enabled`
  // setter (read in the v6 bundle; reproduced by XCUITest). A recognizer left
  // armed keeps handling window moves with an EMPTY touch list, so
  // `locationInElement()` divides by zero and the NaN reaches `camera.center`
  // through an unvalidated MapPoint — after which every camera read throws.
  // iOS steals a touch whenever a system gesture starts on the map, which
  // Reachability makes routine. Bouncing the flag is MapKit's own interrupt.
  container.addEventListener(
    "touchcancel",
    () => {
      map.isScrollEnabled = false;
      map.isScrollEnabled = true;
    },
    { capture: true },
  );

  // Ground screens ride dark like the rest of the app; the live flight
  // map is always light (sunlight-readable, STEERING).
  map.colorScheme =
    appearance === "light" ? mapkit.ColorScheme.Light : mapkit.ColorScheme.Dark;

  // The target of an ANIMATED turn still in flight, or null when the camera
  // is settled. Only that window needs a remembered number: mid-tween the
  // live rotation is not the answer yet, so the glyph rides the target and
  // holds pointing up (track-up) instead of counter-rotating and snapping
  // back. Every other moment reads the camera itself.
  //
  // A cache of what the app last ASKED for is exactly what misoriented the
  // glyph on device: MapKit moves rotation behind the adapter's back — a
  // two-finger twist, a turn the zoom lock refuses, and above all
  // Map.setPadding, which runs `this.rotation = 0` before it re-derives the
  // visible rect (read in the v6 bundle, reproduced in a browser) — so an
  // inset change left the cache describing a camera that no longer existed.
  // Unsnapped there are no further bearing writes to correct it, so the
  // chevron kept pointing at the old north for the rest of the flight.
  //
  // So this one is written narrowly (moveTo latches only a turn the camera
  // really left behind) and cleared broadly: every camera settle drops it,
  // not only the rotation-end that a stranded turn never sends.
  let turningTo: number | null = null;
  const screenBearing = () => turningTo ?? rotationToBearing(map.rotation);

  // The live aircraft glyphs (one per aircraft() handle), redrawn whenever
  // the camera's rotation settles somewhere new: the glyph is screen-fixed,
  // so a camera turn changes its on-screen angle just as much as a new
  // course does, and nothing else would repaint it until the next fix — or
  // ever, once unsnapped.
  const glyphs = new Set<() => void>();

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

  // DIAGNOSTIC (#185): the one fact that decides the root cause is whether
  // `map.center` is readable at the moment of the crash — a degenerate rect
  // makes MapKit throw from inside the getter. Read through try/catch here so
  // asking the question can never itself be the crash.
  let lastInsets: unknown = null;
  registerDiagProbe("mapkit", () => {
    const out: Record<string, unknown> = { lastInsets };
    try {
      const c = map.center;
      out.center = [c.longitude, c.latitude];
    } catch (error) {
      out.centerThrew = String(error);
    }
    try {
      out.rotation = map.rotation;
    } catch (error) {
      out.rotationThrew = String(error);
    }
    try {
      const r = map.visibleMapRect as unknown as {
        origin?: { x?: number; y?: number };
        size?: { width?: number; height?: number };
      };
      out.visibleMapRect = [
        r?.origin?.x,
        r?.origin?.y,
        r?.size?.width,
        r?.size?.height,
      ];
    } catch (error) {
      out.visibleMapRectThrew = String(error);
    }
    out.container = [container.clientWidth, container.clientHeight];
    return out;
  });

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

  // The camera stopped somewhere. Wherever that is, it is the truth now:
  // drop any in-flight-turn latch and re-derive every live glyph's angle
  // from the rotation the camera actually holds.
  function cameraSettled() {
    turningTo = null;
    for (const draw of glyphs) draw();
  }

  // MapKit's one reliable "the camera stopped TURNING" signal, and it covers
  // most of the paths that move rotation: a two-finger twist (gesture end +
  // deceleration end), each non-animated set, the end of an animated turn,
  // and the zeroing inside setPadding. (rotation-change is dead in the v6
  // bundle — its dispatch flag is never set — which is why the compass has
  // to poll instead.) Redrawing the glyphs here is what makes them
  // self-healing: however the rotation moved, the next settle re-derives
  // their angle from the camera that actually exists.
  emap.addEventListener("rotation-end", cameraSettled);

  // The rest of the paths move rotation with NO rotation-end at all. Two of
  // them, both read out of the v6 bundle:
  //
  //  • every region / visible-rect set hard-writes `rotation = 0` onto the
  //    camera it derives, and non-animated that camera is applied
  //    instantly: no rotation tween is created, `_rotating` is never
  //    latched, so cameraDidStopRotating early-returns. Reachable today —
  //    pause a replay in the logbook seat, twist the map, expand it, and
  //    fitBounds turns the camera north while the chevron keeps the
  //    twisted angle until some later fix redraws it.
  //  • an ANIMATED turn the below-zoom-7 camera constraint declines
  //    (constrainCameraRotation zeroes the target camera, then the
  //    equal-camera check skips the tween) reports started and never ends,
  //    stranding `turningTo` on a bearing the camera never took.
  //
  // Both heal on the next region/zoom settle, which is also where the
  // rotate gesture is re-gated. The redraw is idempotent — draw() skips an
  // unchanged transform — and that matters here: region-change-end fires on
  // every follow re-center, i.e. every fix on the live map.
  function regionSettled() {
    syncRotationGesture();
    cameraSettled();
  }
  syncRotationGesture();
  emap.addEventListener("zoom-end", regionSettled);
  emap.addEventListener("region-change-end", regionSettled);

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
      toCoord(center) as Coordinate & { toMapPoint?(): PrivateMapPoint }
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
      // The offset helper sizes the padding compensation for the CURRENT
      // zoom (pixel asymmetry over the live worldSize) — MapKit itself only
      // calls it in same-zoom pans. This move lands at a different zoom,
      // where the same map-point vector covers 2^delta times the pixels:
      // the "flies close, second press snaps exact" miss. Rescale it to the
      // landing scale. Rotation-safe (the vector bakes rotation in; uniform
      // scaling preserves it); symmetric padding returns undefined and the
      // raw point is already right. Apple's own user-location control lands
      // exact the same way, by building its rect at the TARGET zoom.
      // Both the camera copy above and this call must stay BEFORE the
      // DidEnd replay below: it can rewrite camera.zoom synchronously, and
      // the offset must be sized against the zoom target.zoom copied.
      const off = impl._offsetCenterWithPaddingAndRotation?.(point, -1);
      // A fresh PUBLIC MapPoint, never a write into the helper's return:
      // the private surface stays read-only (a future MapKit returning its
      // argument or a cached point must degrade, not corrupt), and the
      // constructor's NaN validation throws into the catch — the clean
      // fallback — on the one path where a bad number could reach the
      // camera.
      const k = Math.pow(2, -delta);
      target.center =
        off && delta !== 0
          ? new mapkit.MapPoint(
              point.x + (off.x - point.x) * k,
              point.y + (off.y - point.y) * k,
            )
          : (off ?? point);
      // Validate BEFORE assigning: the camera's zoom setter launders
      // garbage (`this._zoom = e || 3`), so a post-assignment isFinite
      // check would read back a plausible 3 and animate to continental.
      const zoom = target.zoom + delta;
      if (!Number.isFinite(zoom)) return false;
      target.zoom = zoom;
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
        // DidEnd's suspended-gesture-zoom replay can spawn a fresh tween;
        // launching ours into it would hit the instant-stomp branch, while
        // the fallback composes with a live tween correctly (additiveZoom).
        if (node.cameraAnimation) return false;
      }
      delete impl._visibleMapRect;
      impl.setCameraAnimated(target, true);
      return true;
    } catch {
      return false;
    }
  }

  // Write the padding WITHOUT MapKit's visible-rect re-derivation, through
  // the captured impl. Apple's own opt-out — `setPadding(padding, {
  // updateVisibleMapRect: false })` — stores the padding and re-places the
  // controls (controlsLayer.mapPaddingDidChange, which runs either way) and
  // skips the whole default branch: `this.rotation = 0`, re-derive the
  // padded rect, setVisibleMapRect. That zeroing is #147, and skipping it
  // beats zeroing and re-asserting, which turns the camera to north and
  // back around a pivot that moved in between. It is exactly right here
  // because this app's padding places the Apple logo and Legal link and
  // nothing else — the camera framing is never meant to follow it.
  //
  // Private surface, so it gets the same treatment as the impl capture
  // above: probed, never assumed. False = it did not carry the write (no
  // member, a throw, or a MapKit that ignored the option and zeroed the
  // rotation anyway), and the caller falls back to the public write plus a
  // re-assert. A partial private write costs nothing there: setPadding
  // early-returns on a Padding equal to the one already stored.
  function writePaddingWithoutRect(padding: Padding): boolean {
    if (!impl?.setPadding) return false;
    const was = map.rotation;
    try {
      impl.setPadding(padding, { updateVisibleMapRect: false });
    } catch {
      return false;
    }
    return map.rotation === was && samePadding(map.padding, padding);
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

    setAppearance(next) {
      // colorScheme is a live MapKit property; flipping it re-creates
      // nothing and the camera stays exactly where the pilot left it.
      map.colorScheme =
        next === "light" ? mapkit.ColorScheme.Light : mapkit.ColorScheme.Dark;
    },

    // The Apple logo + Legal link are a license surface; the host's
    // resolved per-edge insets keep them off the notch and home
    // indicator (0 on every edge with no safe area — desktop, portrait
    // L/R). The identical insets drive the button overlay via the
    // cascading var(--ion-safe-area-*) (MapCanvas resolves them off the same
    // probe), so the logo and the buttons move as one.
    setInsets(insets) {
      lastInsets = {
        insets,
        container: [container.clientWidth, container.clientHeight],
      };
      breadcrumb("mapkit.setInsets", lastInsets);
      const padding = new mapkit.Padding(
        insets.top,
        insets.right,
        insets.bottom,
        insets.left,
      );
      // Captured BEFORE anything writes padding, because the probe below
      // can be the thing that zeroes it: a MapKit that dropped the option
      // runs the default path, and then the re-assert has to restore the
      // rotation from before the probe, not the 0 it left behind.
      const rotation = map.rotation;
      // First choice: the write that never touches the camera at all (see
      // writePaddingWithoutRect).
      if (writePaddingWithoutRect(padding)) return;
      // Fallback. The public setter takes MapKit's default path, which
      // zeroes the camera on its way through — literally `this.rotation =
      // 0`, then it re-derives the visible rect north-up (v6 bundle) — so
      // every inset change (a device rotation, the notch moving to the
      // side, the replay pane's glide) snapped a track-up pilot to north.
      // Capture the rotation and re-assert it after, non-animated, exactly
      // the way MapKit's own resize path does (_resizeDetectorDidInstall).
      // No unchanged-inset guard needed: setPadding early-returns on an
      // equal Padding, so an inset that did not move never reaches the
      // reset. The round trip through north is why this is the fallback and
      // not the plan: the re-assert pivots around a center the zeroed
      // camera already re-derived.
      map.padding = padding;
      if (map.rotation !== rotation) map.rotation = rotation;
    },

    destroy() {
      breadcrumb("mapkit.destroy", [
        container.clientWidth,
        container.clientHeight,
      ]);
      map.destroy();
    },

    camera(): Camera {
      breadcrumb("mapkit.camera", [
        container.clientWidth,
        container.clientHeight,
      ]);
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
        const rotation = bearingToRotation(to.bearing);
        // Skip when already at (or turning to) the target — otherwise a
        // steady heading would re-trigger a native turn every fix.
        if (Math.abs(shortestAngle(rotation - map.rotation)) > 0.05) {
          const was = map.rotation;
          const turn = map.setRotationAnimated(rotation, animated);
          // Latch the target ONLY for an animated turn that left the camera
          // behind to tween it there. Latching one the camera will not take
          // is the exact staleness this path exists to avoid, and three of
          // the four outcomes must read the live camera instead:
          //
          //  • null — MapKit refused outright (rotation unavailable on this
          //    renderer): the camera never moves.
          //  • a non-animated set — the camera is already there, and it
          //    ends in rotation-end regardless.
          //  • the rotation moved DURING the call — then it was not tweened
          //    at all. An animated set issued while another camera tween is
          //    in flight takes MapKit's instant-apply branch, is written
          //    straight onto the camera, and is then overwritten by that
          //    tween's next frame; `_rotating` is never latched, so no
          //    rotation-end follows either. The camera is the only truth.
          //
          // The one outcome this cannot tell apart HERE is the turn the
          // below-zoom-7 constraint declines: rotation-start fires, the
          // target camera is zeroed, the equal-camera check skips the
          // tween, and nothing ever ends — indistinguishable at the call
          // site from a real tween that has not ticked yet. cameraSettled()
          // is the backstop; the next settle of any kind drops the latch.
          turningTo =
            animated && turn !== null && map.rotation === was
              ? to.bearing
              : null;
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
      map.setRegionAnimated(region, opts?.animate ?? false);
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
      // The glyph is a passive position marker; it must never swallow a map
      // gesture that starts on it (a pan/tap over the ~48px triangle, which in
      // follow mode sits dead center). pointer-events inherits, so the inner
      // SVG goes through too. (Enforced here rather than via a CSS class on a
      // MapKit-owned container, which a refactor silently dropped.)
      wrapper.style.pointerEvents = "none";
      wrapper.innerHTML = AIRCRAFT_SVG;
      const svg = wrapper.firstElementChild as SVGElement;
      let ann: Annotation | null = null;
      // The glyph's geographic course; null while no glyph is on the map.
      let heading: number | null = null;
      // The transform last written. draw() runs on every camera settle, and
      // region-change-end fires once per follow re-center — every fix on the
      // battery-sensitive live map — so a redraw that changes nothing has to
      // cost nothing.
      let drawn = "";
      // Screen-fixed glyph, snapped (no animation): it points to the
      // on-screen heading — geographic course minus the camera's bearing (0
      // in track-up, so it holds pointing up as the camera turns under it).
      // Both terms move, so this runs on a camera settle as well as a fix.
      const draw = () => {
        if (heading === null) return;
        const screenAngle = heading - screenBearing();
        const transform = `translate(-50%, -50%) rotate(${screenAngle}deg)`;
        if (transform === drawn) return;
        drawn = transform;
        svg.style.transform = transform;
      };
      glyphs.add(draw);
      container.setAttribute("data-aircraft-layer", "true");
      return {
        set(state: AircraftState | null) {
          if (!state) {
            if (ann) map.removeAnnotation(ann);
            ann = null;
            heading = null;
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
          heading = state.heading;
          draw();
        },
        remove() {
          glyphs.delete(draw);
          if (ann) map.removeAnnotation(ann);
          ann = null;
          heading = null;
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
          // A provider/appearance swap destroys the map before React has
          // unmounted the subscriber (MapCanvas destroys, then notifies
          // null); reading a destroyed map's rotation throws. Fold the
          // loop instead of surfacing one TypeError per swap.
          try {
            if (map.rotation !== last) {
              last = map.rotation;
              handler({ at: [map.center.longitude, map.center.latitude] });
            }
          } catch {
            return;
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
