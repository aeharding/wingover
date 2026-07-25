// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MapView } from "../types";
import { createMapKitMapView } from "./adapter";

// The real loader injects Apple's CDN bundle; the suite drives the scripted
// MapKit below instead (installed on globalThis, exactly where the adapter
// reads it from).
vi.mock("./loader", () => ({ loadMapKit: () => Promise.resolve() }));

const norm = (d: number) => ((d % 360) + 360) % 360;

// ─── A scripted MapKit JS 6 ─────────────────────────────────────────────
//
// Faithful to the three behaviours this suite is about, all read out of the
// shipped v6 bundle and confirmed in a browser against the real library:
//
//  1. `map.padding = …` calls `setPadding`, which runs `this.rotation = 0`
//     before it re-derives the visible rect — so ANY inset change (a device
//     rotation, the notch moving to the side, the replay pane's glide)
//     silently turns the camera to north. It early-returns on an equal
//     Padding, so an unchanged inset never gets that far.
//  2. Every rotation settle ends in `mapDidStopRotating`, i.e. a
//     "rotation-end" event: a two-finger twist, each non-animated set, and
//     the end of an animated turn. (Its "rotation-change" sibling is dead
//     code — the flag guarding its dispatch is never set.)
//  3. `setRotationAnimated` returns null when it refuses outright (rotation
//     unavailable, a non-finite angle, nothing to do), and the map, having
//     started the turn, otherwise. A turn the zoom lock declines still
//     reports started and still ends in "rotation-end" — the camera simply
//     never moves.
class FakeMap {
  rotationValue = 0;
  paddingValue = { top: 0, right: 0, bottom: 0, left: 0 };
  center = { latitude: 37.8, longitude: -122.4 };
  cameraDistance = 5000;
  zoom = 14;
  colorScheme = "light";
  mapType = "standard";
  isRotationEnabled = true;
  isZoomEnabled = true;
  isRotationAvailable = true;
  // The zoom lock: below zoom 7 MapKit's camera constraint declines the
  // turn without declining the CALL.
  rotationLocked = false;
  selectedAnnotation: unknown = null;
  annotations: FakeAnnotation[] = [];
  pendingRotation: number | null = null;
  listeners = new Map<string, ((event: unknown) => void)[]>();

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
    if (target === this.rotationValue) return null;
    if (animated) {
      this.pendingRotation = target;
      return this;
    }
    if (!this.rotationLocked) this.rotationValue = target;
    this.dispatch("rotation-end");
    return this;
  }

  // The end of an animated turn (MapKit: cameraAnimationDidEnd →
  // cameraDidStopRotating → mapDidStopRotating).
  finishTurn() {
    if (this.pendingRotation === null) return;
    this.rotationValue = this.pendingRotation;
    this.pendingRotation = null;
    this.dispatch("rotation-end");
  }

  // A two-finger twist: the camera moves, the app was never asked.
  twistTo(rotation: number) {
    this.rotationValue = norm(rotation);
    this.dispatch("rotation-end");
  }

  get padding() {
    return this.paddingValue;
  }

  set padding(next: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  }) {
    const same =
      next.top === this.paddingValue.top &&
      next.right === this.paddingValue.right &&
      next.bottom === this.paddingValue.bottom &&
      next.left === this.paddingValue.left;
    if (same) return;
    this.paddingValue = next;
    this.rotation = 0;
  }

  setCenterAnimated(center: { latitude: number; longitude: number }) {
    this.center = center;
  }

  setCameraDistanceAnimated(distance: number) {
    this.cameraDistance = distance;
  }

  setRegionAnimated() {}

  addAnnotation(annotation: FakeAnnotation) {
    this.annotations.push(annotation);
  }

  removeAnnotation(annotation: FakeAnnotation) {
    this.annotations = this.annotations.filter((a) => a !== annotation);
  }

  addOverlay() {}
  removeOverlay() {}
  destroy() {}

  // Web-mercator pixels, so the adapter's projection-derived zoom is real.
  convertCoordinateToPointOnPage(coordinate: {
    latitude: number;
    longitude: number;
  }) {
    const scale = (256 * Math.pow(2, this.zoom)) / 360;
    return { x: coordinate.longitude * scale, y: -coordinate.latitude * scale };
  }

  convertPointOnPageToCoordinate(point: { x: number; y: number }) {
    const scale = (256 * Math.pow(2, this.zoom)) / 360;
    return { latitude: -point.y / scale, longitude: point.x / scale };
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
  Coordinate: class {
    constructor(
      public latitude: number,
      public longitude: number,
    ) {}
  },
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
    toCoordinateRegion() {
      return { center: null, span: { latitudeDelta: 1, longitudeDelta: 1 } };
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

describe("mapkit adapter: aircraft glyph vs the camera that exists", () => {
  beforeEach(() => {
    (globalThis as unknown as { mapkit: unknown }).mapkit = fakeMapKit;
    created.length = 0;
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
    view.setInsets({ top: 0, right: 59, bottom: 21, left: 59 });

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
    view.setInsets({ top: 0, right: 59, bottom: 21, left: 59 });
    aircraft.set({ at: AT, heading: 270 });
    expectGlyphMatchesCamera(270);

    view.setInsets({ top: 59, right: 0, bottom: 34, left: 0 });
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

  it("does not orient the glyph against a turn the map declined", async () => {
    const view = await createView();
    const aircraft = view.aircraft();
    // Zoomed out past MapKit's rotation lock: the call is accepted, the
    // camera stays north-up.
    theMap().rotationLocked = true;
    view.moveTo({ center: AT, bearing: 270 }, { animate: false });
    aircraft.set({ at: AT, heading: 270 });

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

    theMap().finishTurn();
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
});
