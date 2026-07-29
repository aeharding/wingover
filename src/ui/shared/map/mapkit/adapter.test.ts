// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MapView } from "../types";
import { createMapKitMapView } from "./adapter";

// The real loader injects Apple's CDN bundle; the suite drives the scripted
// MapKit below instead (installed on globalThis, exactly where the adapter
// reads it from).
vi.mock("./loader", () => ({ loadMapKit: () => Promise.resolve() }));

const norm = (d: number) => ((d % 360) + 360) % 360;

interface PaddingLike {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const samePadding = (a: PaddingLike, b: PaddingLike) =>
  a.top === b.top &&
  a.right === b.right &&
  a.bottom === b.bottom &&
  a.left === b.left;

// MapKit's camera constraint re-derives isRotationLocked from the camera
// zoom on every change: `this.isRotationLocked = camera.zoom < 7`.
const ROTATION_LOCK_ZOOM = 7;

// mapkit.Map hides its implementation behind a Symbol-keyed accessor
// (`map._(key)`), and the adapter fishes the key out of one wrapped call to
// reach the private members. Model the indirection or the adapter's private
// paths are simply unreachable from a test.
const IMPL_KEY = Symbol("mapkit.Map impl");

// What the PRIVATE surface offers on the next map the suite constructs. The
// adapter captures the impl exactly ONCE, at construction, so these are read
// there rather than per call.
const privateSurface = { setPadding: true, honorsOptions: true };

// ─── A scripted MapKit JS 6 ─────────────────────────────────────────────
//
// Faithful to the behaviours this suite is about, all read out of the
// shipped v6 bundle (mapkit.core.984238.js) and confirmed in a browser
// against the real library:
//
//  1. `setPadding(padding, { updateVisibleMapRect = true })`. The default
//     path — the only one the public `map.padding =` setter can reach —
//     runs `this.rotation = 0` and re-derives the visible map rect, so ANY
//     inset change silently turns the camera to north. Passing the option
//     false skips both and just stores the padding and re-places the
//     controls. Either way it early-returns on an equal Padding.
//  2. Every rotation settle ends in `mapDidStopRotating`, i.e. a
//     "rotation-end" event — but only the paths that latch `_rotating`
//     reach it. (Its "rotation-change" sibling is dead code: the flag
//     guarding its dispatch is never set.)
//  3. `setRotationAnimated` returns null when it refuses outright (rotation
//     unavailable, a non-finite angle, nothing to do), and the map
//     otherwise. "Otherwise" covers three different fates:
//       • a real tween, which ends in rotation-end;
//       • a turn the below-zoom-7 constraint declines — rotation-start
//         fires, constrainCameraRotation zeroes the target camera, the
//         equal-camera check then skips the tween, and NOTHING ever ends;
//       • an animated turn issued while another camera tween is in flight,
//         which is applied instantly, overwritten by that tween's next
//         frame, and never ends either.
//  4. A region / visible-rect set hard-writes `rotation = 0` onto the
//     camera it derives. Non-animated it lands instantly, so `_rotating` is
//     never latched and no rotation-end fires — only the region settle.
class FakeMap {
  rotationValue = 0;
  paddingValue: PaddingLike = { top: 0, right: 0, bottom: 0, left: 0 };
  // Where the Apple logo and Legal link sit. setPadding re-places the
  // controls on BOTH paths, which is the only reason this app writes
  // padding at all.
  controlsPadding: PaddingLike = { top: 0, right: 0, bottom: 0, left: 0 };
  centerValue = { latitude: 37.8, longitude: -122.4 };
  cameraDistance = 5000;
  zoom = 14;
  colorScheme = "light";
  mapType = "standard";
  isRotationEnabled = true;
  isZoomEnabled = true;
  // Every write, in order: the guard is a bounce, so the ORDER is the assertion.
  scrollEnabledWrites: boolean[] = [];
  private scrollEnabled = true;
  get isScrollEnabled() {
    return this.scrollEnabled;
  }
  set isScrollEnabled(next: boolean) {
    this.scrollEnabled = next;
    this.scrollEnabledWrites.push(next);
  }
  isRotationAvailable = true;
  selectedAnnotation: unknown = null;
  annotations: FakeAnnotation[] = [];
  destroyed = false;
  // How many times MapKit re-derived the visible map rect, i.e. moved the
  // camera framing. A padding write that only places the logo must not.
  visibleMapRectUpdates = 0;
  // MapKit runs exactly ONE camera tween (mapNode.cameraAnimation), and
  // every in-flight decision below turns on whether it is set. `rotation`
  // is the camera the tween carries: its frames overwrite anything written
  // underneath it, which is how an instant-applied turn gets stomped.
  cameraAnimation: { rotating: boolean; rotation: number } | null = null;
  listeners = new Map<string, ((event: unknown) => void)[]>();

  // The private implementation the adapter captures. In the real bundle the
  // public Map is a shell and this object owns everything; the fake keeps
  // one state and exposes just the private members the adapter reaches for.
  private readonly impl: {
    setPadding?: (padding: PaddingLike, options?: PaddingOptions) => void;
  } = privateSurface.setPadding
    ? {
        setPadding: (padding, options) =>
          // A MapKit that does not know the option runs its default path.
          this.setPadding(padding, privateSurface.honorsOptions ? options : {}),
      }
    : {};

  _(key: unknown) {
    return key === IMPL_KEY ? this.impl : undefined;
  }

  // The zoom lock. MapKit declines the TURN without declining the CALL.
  get rotationLocked() {
    return this.zoom < ROTATION_LOCK_ZOOM;
  }

  // Routed through `_` on purpose: this is the public member the adapter
  // reads while it has the accessor wrapped, so it is how the impl key
  // leaks out (adapter.ts, the `impl` capture).
  get center() {
    void this._(IMPL_KEY);
    return this.centerValue;
  }

  set center(next: { latitude: number; longitude: number }) {
    this.centerValue = next;
    // A non-animated center set lands instantly and the region settles
    // right there: following re-centers the map every fix, and every one of
    // those fires region-change-end. Under a tween it does not —
    // _cameraChangesMayHaveEnded is gated on there being no animation.
    if (!this.cameraAnimation) this.dispatch("region-change-end");
  }

  get rotation() {
    return this.rotationValue;
  }

  set rotation(degrees: number) {
    this.setRotationAnimated(degrees, false);
  }

  setRotationAnimated(degrees: number, animated?: boolean) {
    if (!this.isRotationAvailable) return null;
    if (!Number.isFinite(degrees)) return null;
    const target = norm(degrees);
    // `const n = target - rotation; if (!n) return null` — nothing to turn.
    if (target === this.rotationValue) return null;
    if (animated) {
      // mapCanStartRotating(): the cancelable "rotation-start" event, and
      // it is dispatched before the camera work whatever happens next.
      this.dispatch("rotation-start");
      if (this.rotationLocked) {
        // constrainCameraRotation zeroes the TARGET camera below zoom 7;
        // the equal-camera check then skips the branch entirely. No tween,
        // no camera move, and rotation-end NEVER fires. The call still
        // returns the map.
        return this;
      }
      if (this.cameraAnimation) {
        // MapKit's in-flight branch (`!animated && !constrained ||
        // this.cameraAnimation`): applied instantly, then overwritten by
        // that tween's next frame. `_rotating` is never latched, so
        // cameraDidStopRotating early-returns and nothing ends.
        this.rotationValue = target;
        return this;
      }
      this.cameraAnimation = { rotating: true, rotation: target };
      return this;
    }
    // Non-animated: rotateCameraAroundMapPoint (a no-op while the zoom lock
    // holds) and then mapDidStopRotating() unconditionally.
    if (!this.rotationLocked) this.rotationValue = target;
    this.dispatch("rotation-end");
    return this;
  }

  // The tween's last frame, then cameraAnimationDidEnd.
  finishTween() {
    const animation = this.cameraAnimation;
    if (!animation) return;
    this.cameraAnimation = null;
    // The tween owns the camera: its final frame carries the rotation it
    // was built with, which is what stomps an instant-applied turn.
    this.rotationValue = animation.rotation;
    // cameraAnimationDidEnd's order: the region settle comes out of
    // cameraDidStopRotating's _cameraChangesMayHaveEnded, so it lands
    // BEFORE rotation-end — and rotation-end only for a rotating tween.
    this.dispatch("region-change-end");
    if (animation.rotating) this.dispatch("rotation-end");
  }

  // A two-finger twist: the camera moves, the app was never asked.
  twistTo(rotation: number) {
    this.rotationValue = norm(rotation);
    this.dispatch("rotation-end");
  }

  get padding() {
    return this.paddingValue;
  }

  // The public setter forwards with no options, so it always takes the
  // rect-updating default path.
  set padding(next: PaddingLike) {
    this.setPadding(next);
  }

  setPadding(padding: PaddingLike, options: PaddingOptions = {}) {
    const { updateVisibleMapRect = true } = options;
    if (samePadding(padding, this.paddingValue)) return;
    this.paddingValue = {
      top: padding.top,
      right: padding.right,
      bottom: padding.bottom,
      left: padding.left,
    };
    if (updateVisibleMapRect) {
      // `this.rotation = 0` — the impl's own property setter, so it runs
      // setRotationAnimated(0, false) and DOES end in rotation-end.
      this.rotation = 0;
      this.visibleMapRectUpdates += 1;
    }
    this.controlsPadding = this.paddingValue;
  }

  setCenterAnimated(
    center: { latitude: number; longitude: number },
    animated?: boolean,
  ) {
    this.centerValue = center;
    if (animated) {
      this.cameraAnimation = { rotating: false, rotation: this.rotationValue };
      return;
    }
    this.dispatch("region-change-end");
  }

  setCameraDistanceAnimated(distance: number) {
    this.cameraDistance = distance;
  }

  setRegionAnimated(region: unknown, animated?: boolean) {
    void region;
    // _setVisibleMapRect → node.setVisibleMapRectAnimated, which derives
    // the camera for the rect and hard-sets `rotation = 0` on it before
    // handing it to setCameraAnimated.
    this.visibleMapRectUpdates += 1;
    if (animated) {
      this.cameraAnimation = { rotating: false, rotation: 0 };
      return;
    }
    this.rotationValue = 0;
    this.dispatch("region-change-end");
  }

  addAnnotation(annotation: FakeAnnotation) {
    this.annotations.push(annotation);
  }

  removeAnnotation(annotation: FakeAnnotation) {
    this.annotations = this.annotations.filter((a) => a !== annotation);
  }

  addOverlay() {}
  removeOverlay() {}
  destroy() {
    this.destroyed = true;
  }

  // Web-mercator pixels, so the adapter's projection-derived zoom is real —
  // including the camera's rotation, which turns projected vectors on the
  // page exactly as the real bundle does (the x-only zoom-probe regression
  // hid behind a fake that never rotated).
  convertCoordinateToPointOnPage(coordinate: {
    latitude: number;
    longitude: number;
  }) {
    const scale = (256 * Math.pow(2, this.zoom)) / 360;
    const x = coordinate.longitude * scale;
    const y = -coordinate.latitude * scale;
    const r = (this.rotationValue * Math.PI) / 180;
    return {
      x: x * Math.cos(r) - y * Math.sin(r),
      y: x * Math.sin(r) + y * Math.cos(r),
    };
  }

  convertPointOnPageToCoordinate(point: { x: number; y: number }) {
    const scale = (256 * Math.pow(2, this.zoom)) / 360;
    const r = (this.rotationValue * Math.PI) / 180;
    const x = point.x * Math.cos(r) + point.y * Math.sin(r);
    const y = -point.x * Math.sin(r) + point.y * Math.cos(r);
    return { latitude: -y / scale, longitude: x / scale };
  }

  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => l !== listener),
    );
  }

  dispatch(type: string) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener({});
    }
  }
}

interface PaddingOptions {
  updateVisibleMapRect?: boolean;
}

class FakeAnnotation {
  element: HTMLElement | null = null;
  constructor(
    public coordinate: unknown,
    factory?: () => HTMLElement,
  ) {
    this.element = factory ? factory() : null;
  }
  addEventListener() {}
  removeEventListener() {}
}

class FakeCoordinate {
  constructor(
    public latitude: number,
    public longitude: number,
  ) {}
}

// Every map the suite constructs, newest last.
const created: FakeMap[] = [];

function theMap(): FakeMap {
  const map = created.at(-1);
  if (!map) throw new Error("no map has been created");
  return map;
}

const fakeMapKit = {
  Map: class extends FakeMap {
    constructor() {
      super();
      created.push(this);
    }
  },
  Coordinate: FakeCoordinate,
  Padding: class {
    constructor(
      public top: number,
      public right: number,
      public bottom: number,
      public left: number,
    ) {}
  },
  MapPoint: class {
    constructor(
      public x: number,
      public y: number,
    ) {}
  },
  Annotation: FakeAnnotation,
  MarkerAnnotation: FakeAnnotation,
  Style: class {},
  PolylineOverlay: class {
    constructor(public points: unknown[]) {}
  },
  BoundingRegion: class {
    constructor(
      public north: number,
      public east: number,
      public south: number,
      public west: number,
    ) {}
    toCoordinateRegion() {
      return {
        center: new FakeCoordinate(
          (this.north + this.south) / 2,
          (this.east + this.west) / 2,
        ),
        span: {
          latitudeDelta: this.north - this.south,
          longitudeDelta: this.east - this.west,
        },
      };
    }
  },
  MapType: { Hybrid: "hybrid", MutedStandard: "muted" },
  FeatureVisibility: { Hidden: "hidden" },
  ColorScheme: { Light: "light", Dark: "dark" },
};

// The glyph element MapKit was handed for the aircraft annotation.
function glyphSvg(): SVGElement {
  const wrapper = theMap()
    .annotations.map((a) => a.element)
    .find((el): el is HTMLElement => !!el?.querySelector("svg"));
  const svg = wrapper?.querySelector("svg") as SVGElement | null;
  if (!svg) throw new Error("no aircraft glyph on the map");
  return svg;
}

// The glyph's on-screen angle, as the SVG carries it.
function glyphAngle(svg: SVGElement = glyphSvg()): number {
  const match = /rotate\(([-\d.]+)deg\)/.exec(svg.style.transform);
  if (!match) throw new Error("aircraft glyph has no rotation");
  return norm(Number(match[1]));
}

// The camera bearing the map actually holds (MapKit rotation is
// opposite-signed to the app's bearing).
function cameraBearing(): number {
  return norm(-theMap().rotation);
}

// Every rotation event the map dispatched since the tap, in order — the
// suite asserts on the ones that DON'T come as much as the ones that do.
function recordRotationEvents(): string[] {
  const seen: string[] = [];
  for (const type of ["rotation-start", "rotation-end"]) {
    theMap().addEventListener(type, () => seen.push(type));
  }
  return seen;
}

// THE CONTRACT the MapLibre backend gets for free from its GL matrix: the
// glyph is drawn at the aircraft's geographic course MINUS the camera's
// bearing, so it reads as the on-screen heading no matter how the map is
// turned. Every desync in this file is a violation of this one line.
function expectGlyphMatchesCamera(course: number) {
  expect(norm(glyphAngle() + cameraBearing())).toBeCloseTo(norm(course), 6);
}

async function createView(): Promise<MapView> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return createMapKitMapView(container, "street", "light");
}

const AT: [number, number] = [-122.4, 37.8];
const LANDSCAPE = { top: 0, right: 59, bottom: 21, left: 59 };
const PORTRAIT = { top: 59, right: 0, bottom: 34, left: 0 };

describe("mapkit adapter: aircraft glyph vs the camera that exists", () => {
  beforeEach(() => {
    (globalThis as unknown as { mapkit: unknown }).mapkit = fakeMapKit;
    created.length = 0;
    privateSurface.setPadding = true;
    privateSurface.honorsOptions = true;
    document.body.innerHTML = "";
  });

  it("holds the glyph pointing up while track-up turns the camera", async () => {
    const view = await createView();
    const aircraft = view.aircraft();
    for (const course of [270, 275, 10]) {
      view.moveTo({ center: AT, bearing: course }, { animate: false });
      aircraft.set({ at: AT, heading: course });
      expect(glyphAngle()).toBeCloseTo(0, 6);
      expectGlyphMatchesCamera(course);
    }
  });

  it("keeps the camera's rotation across an inset change", async () => {
    const view = await createView();
    view.moveTo({ center: AT, bearing: 270 }, { animate: false });
    expect(view.camera().bearing).toBeCloseTo(270, 6);

    // A device rotation: the safe-area probe re-resolves and the host
    // pushes new insets. MapKit's setPadding would zero the camera.
    view.setInsets(LANDSCAPE);

    expect(view.camera().bearing).toBeCloseTo(270, 6);
  });

  it("places the padding without re-deriving the visible map rect", async () => {
    const view = await createView();
    view.moveTo({ center: AT, bearing: 270 }, { animate: false });
    const rects = theMap().visibleMapRectUpdates;

    view.setInsets(LANDSCAPE);

    // Apple's own opt-out: the logo moves, the camera framing does not,
    // and the rotation is never zeroed in the first place.
    expect(theMap().controlsPadding).toEqual(LANDSCAPE);
    expect(theMap().visibleMapRectUpdates).toBe(rects);
    expect(view.camera().bearing).toBeCloseTo(270, 6);
  });

  it("falls back to the public padding write when the private one is gone", async () => {
    privateSurface.setPadding = false;
    const view = await createView();
    view.moveTo({ center: AT, bearing: 270 }, { animate: false });

    view.setInsets(LANDSCAPE);

    // The default path ran — rect re-derived, camera zeroed — and the
    // adapter put the rotation back.
    expect(theMap().visibleMapRectUpdates).toBe(1);
    expect(theMap().controlsPadding).toEqual(LANDSCAPE);
    expect(view.camera().bearing).toBeCloseTo(270, 6);
  });

  it("falls back when MapKit ignores the no-rect padding option", async () => {
    privateSurface.honorsOptions = false;
    const view = await createView();
    view.moveTo({ center: AT, bearing: 270 }, { animate: false });

    view.setInsets(LANDSCAPE);

    // The private call went through and zeroed the camera anyway. The
    // adapter checks rather than assumes, so the rotation still survives.
    expect(theMap().visibleMapRectUpdates).toBe(1);
    expect(theMap().controlsPadding).toEqual(LANDSCAPE);
    expect(view.camera().bearing).toBeCloseTo(270, 6);
  });

  it("keeps the glyph oriented after unsnapping and rotating the device", async () => {
    const view = await createView();
    const aircraft = view.aircraft();
    // Snap location, then snap direction: follow + track-up at course 270.
    view.moveTo({ center: AT, bearing: 270 }, { animate: false });
    aircraft.set({ at: AT, heading: 270 });
    expectGlyphMatchesCamera(270);

    // A small drag auto-unsnaps: follow AND track-up drop, so nothing ever
    // writes a bearing again — but the camera keeps its rotated heading.
    // Then the device rotates: portrait -> landscape -> portrait.
    view.setInsets(LANDSCAPE);
    aircraft.set({ at: AT, heading: 270 });
    expectGlyphMatchesCamera(270);

    view.setInsets(PORTRAIT);
    aircraft.set({ at: AT, heading: 270 });
    expectGlyphMatchesCamera(270);
  });

  it("re-orients the glyph on a twist the app never asked for, with no new fix", async () => {
    const view = await createView();
    const aircraft = view.aircraft();
    view.moveTo({ center: AT, bearing: 270 }, { animate: false });
    aircraft.set({ at: AT, heading: 270 });

    theMap().twistTo(45); // bearing 315

    expectGlyphMatchesCamera(270);
    expect(view.camera().bearing).toBeCloseTo(315, 6);
  });

  it("re-orients the glyph when a region set turns the camera north", async () => {
    const view = await createView();
    const aircraft = view.aircraft();
    aircraft.set({ at: AT, heading: 270 });
    // A paused replay in the logbook seat: twist the map, then expand it
    // and the seat re-fits the track.
    theMap().twistTo(45);
    expectGlyphMatchesCamera(270);
    const events = recordRotationEvents();

    view.fitBounds([
      [-122.5, 37.7],
      [-122.3, 37.9],
    ]);

    // The region set zeroed the rotation with NO rotation-end at all; the
    // region settle is the only thing that reports it.
    expect(events).toEqual([]);
    expect(cameraBearing()).toBeCloseTo(0, 6);
    expectGlyphMatchesCamera(270);
  });

  it("does not orient the glyph against a turn the map declined", async () => {
    const view = await createView();
    const aircraft = view.aircraft();
    // Zoomed out past MapKit's rotation lock: the call is accepted, the
    // camera stays north-up.
    theMap().zoom = 5;
    view.moveTo({ center: AT, bearing: 270 }, { animate: false });
    aircraft.set({ at: AT, heading: 270 });

    expect(cameraBearing()).toBeCloseTo(0, 6);
    expectGlyphMatchesCamera(270);
  });

  it("clears the turn latch when the zoom lock declines an ANIMATED turn", async () => {
    const view = await createView();
    const aircraft = view.aircraft();
    theMap().zoom = 5;
    const events = recordRotationEvents();

    // The compass tap, below the rotation lock: MapKit reports the turn
    // started and the camera never moves. Nothing will ever end it.
    view.moveTo({ bearing: 270 }, { animate: true });
    aircraft.set({ at: AT, heading: 270 });
    expect(events).toEqual(["rotation-start"]);

    // The next settle of any kind — here a follow re-center — heals it.
    view.moveTo({ center: AT }, { animate: false });

    expect(events).toEqual(["rotation-start"]);
    expect(cameraBearing()).toBeCloseTo(0, 6);
    expectGlyphMatchesCamera(270);
  });

  it("does not latch an animated turn that an in-flight tween stomps", async () => {
    const view = await createView();
    const aircraft = view.aircraft();
    // A pan tween is running...
    view.moveTo({ center: [-122.5, 37.9] }, { animate: true });
    const events = recordRotationEvents();
    // ...and an animated turn issued into it is applied INSTANTLY rather
    // than tweened, so the camera really is at 270 right now.
    view.moveTo({ bearing: 270 }, { animate: true });
    aircraft.set({ at: AT, heading: 270 });
    expect(cameraBearing()).toBeCloseTo(270, 6);
    expectGlyphMatchesCamera(270);

    theMap().finishTween();

    // The tween's last frame put the rotation back where it started, and
    // no rotation-end was ever coming for the turn.
    expect(events).toEqual(["rotation-start"]);
    expect(cameraBearing()).toBeCloseTo(0, 6);
    expectGlyphMatchesCamera(270);
  });

  it("rides the target of an animated turn, then settles on the camera", async () => {
    const view = await createView();
    const aircraft = view.aircraft();
    // The compass tap is the one animated turn in the app.
    view.moveTo({ bearing: 90 }, { animate: true });
    aircraft.set({ at: AT, heading: 90 });
    // Mid-tween the camera has not moved yet; the glyph rides the target
    // rather than counter-rotating and snapping back.
    expect(glyphAngle()).toBeCloseTo(0, 6);

    theMap().finishTween();
    expectGlyphMatchesCamera(90);
  });

  it("stops redrawing a glyph that was removed", async () => {
    const view = await createView();
    const aircraft = view.aircraft();
    view.moveTo({ center: AT, bearing: 270 }, { animate: false });
    aircraft.set({ at: AT, heading: 270 });
    const svg = glyphSvg();
    const before = glyphAngle(svg);
    aircraft.remove();

    theMap().twistTo(45);

    expect(glyphAngle(svg)).toBeCloseTo(before, 6);
  });

  it("destroys the map, and a late event does not throw into the listeners", async () => {
    const view = await createView();
    const aircraft = view.aircraft();
    view.moveTo({ center: AT, bearing: 270 }, { animate: false });
    aircraft.set({ at: AT, heading: 270 });

    view.destroy();

    expect(theMap().destroyed).toBe(true);
    // MapKit can flush a queued event after destroy(); the adapter's
    // map-level rotation-end listener must ride it out.
    expect(() => theMap().twistTo(45)).not.toThrow();
  });
});

// A cancelled touch on the map leaves MapKit's pan recognizer armed, and the
// next move anywhere on the page poisons the camera. The whole investigation,
// the device trail and the XCUITest reproduction are on #185.
describe("mapkit adapter: a cancelled touch unwinds the pan recognizer", () => {
  beforeEach(() => {
    (globalThis as unknown as { mapkit: unknown }).mapkit = fakeMapKit;
    created.length = 0;
    privateSurface.setPadding = true;
    privateSurface.honorsOptions = true;
    document.body.innerHTML = "";
  });

  it("bounces isScrollEnabled when a touch on the map is cancelled", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    await createMapKitMapView(container, "street", "light");
    expect(theMap().scrollEnabledWrites).toEqual([]);

    // MapKit builds its own DOM inside the container, so the real cancel
    // targets a descendant — the listener has to catch it on the way down.
    const inner = document.createElement("div");
    container.appendChild(inner);
    inner.dispatchEvent(new Event("touchcancel", { bubbles: true }));

    expect(theMap().scrollEnabledWrites).toEqual([false, true]);
    expect(theMap().isScrollEnabled).toBe(true);
  });

  it("leaves scrolling alone when no touch is cancelled", async () => {
    const view = await createView();
    view.moveTo({ center: AT, bearing: 270 }, { animate: false });

    expect(theMap().scrollEnabledWrites).toEqual([]);
  });
});

// The zoom probe projects a small eastward step and reads pixels-per-degree
// off it. A rotated camera turns that step on screen, so an x-only read
// shrinks by cos(rotation) and under-reports the zoom — and because every
// zoom write is applied as a cameraDistance RATIO off that reading, the
// camera then lands exactly that far past what was asked. Pilot-visible as
// the ZoomControl's whole range rendering way zoomed in after a Mac trackpad
// pinch left a twist on the camera.
describe("mapkit adapter: the zoom probe vs a rotated camera", () => {
  beforeEach(() => {
    (globalThis as unknown as { mapkit: unknown }).mapkit = fakeMapKit;
    created.length = 0;
    privateSurface.setPadding = true;
    privateSurface.honorsOptions = true;
    document.body.innerHTML = "";
  });

  it("reads the same zoom however the camera is turned", async () => {
    const view = await createView();
    expect(view.camera().zoom).toBeCloseTo(14, 6);

    // cos(60°) = 0.5: an x-only probe would read a whole level low.
    theMap().twistTo(60);

    expect(view.camera().zoom).toBeCloseTo(14, 6);
  });

  it("lands a zoom set exactly where asked on a twisted camera", async () => {
    const view = await createView();
    theMap().twistTo(60);

    view.moveTo({ zoom: 12 }, { animate: false });

    // Two levels out from 14 = 4x the camera distance. The x-only probe
    // read 13, scaled by 2x, and left the camera a level too far in.
    expect(theMap().cameraDistance).toBeCloseTo(5000 * 4, 6);
  });
});
