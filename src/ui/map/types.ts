import type { Feature } from "geojson";

import type { MapViewKind } from "./config";

// The backend-agnostic map surface. One implementation wraps MapLibre GL
// (maplibre/adapter.ts); a MapKit JS implementation can slot in behind the
// same interface. Consumers (pages, LiveTrackMap) speak only MapView — none
// of them import maplibre-gl.
//
// Split of concerns: MapView is a DUMB primitive surface. All app-specific
// choreography (following, track-up, zoom) lives ABOVE it in the consumer and
// must never fork per backend. The live view is event-driven: it updates once
// per GPS fix (~1 Hz) — the aircraft snaps to the newest fix and pushes
// {position, heading} via aircraft().set(); the adapter renders it however
// its backend can (MapLibre: a WebGL custom layer; MapKit: an annotation).

export type { MapViewKind };

// The flown-track line width. Shared so the committed line (a Line the live
// view draws) and the aircraft's uncommitted tail (drawn by the backend)
// match and join seamlessly. Lives here — with no backend dependency — so
// the live view can read it without pulling in a map backend.
export const TRACK_LINE_WIDTH_PX = 4;

// The planned optimal-path reference line: grey so it never competes with the
// cyan flown track (which is how drift reads). Shared by the live map and the
// flight detail map so the two never drift apart.
export const PLAN_LINE_COLOR = "#8f96a3";

// The one app cyan — the flown track and the aircraft glyph. Wide-gamut
// display-p3 so it matches the in-flight stat cyan exactly; the TS twin of
// --wingover-accent / --stat-cyan in theme.css (map colors are JS strings
// passed to the backends, not CSS). Keep in sync.
export const ACCENT_CYAN = "color(display-p3 0 0.7 1)";

// The waypoint palette, shared by the plan page and the live map so a pin
// reads the same everywhere: planned pins/route GREEN, ad-hoc pins YELLOW —
// each distinct from the other, from the cyan track, and from the grey plan
// line. Numbers are drawn black on top (sunlight contrast).
export const PLANNED_COLOR = "#35e06a";
export const ADHOC_COLOR = "#ffd60a";

// [longitude, latitude] — GeoJSON coordinate order, matching the geometry
// the app already builds for its line sources.
export type LngLat = [number, number];

// [southwest, northeast].
export type Bounds = [LngLat, LngLat];

export interface Insets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface Camera {
  center: LngLat;
  zoom: number;
  bearing: number; // degrees, 0 = north-up
  padding: Insets;
}

export interface MoveOptions {
  // false / omitted → instant (jump). true → ease. "fly" → zoom-out-and-in.
  animate?: boolean | "fly";
}

export type Gesture =
  | "longpress" // a press held in place → a geographic point
  | "down" // pointer/touch down (interaction begins)
  | "up" // pointer/touch up / cancel (interaction ends)
  | "dragstart"
  | "dragend"
  | "zoom" // zoom changed (per-frame while zooming)
  | "zoomend"
  | "wheel"; // raw wheel/trackpad — hijackable for custom zoom

export interface GestureEvent {
  at: LngLat;
  // Wheel only:
  deltaY?: number;
  ctrlKey?: boolean; // trackpad pinch reports ctrlKey
  preventDefault?: () => void; // suppress the backend's native zoom
}

export type Unsub = () => void;

export interface LineStyle {
  // A solid color, or a data-driven ["get", prop] reading a per-feature
  // property (used by the all-flights composite).
  color: string | ["get", string];
  width: number;
  dash?: [number, number];
  opacity?: number;
  // The adapter reflects `data-${testId}-layer="true"` on the map element
  // once the layer is present — an e2e readiness hook.
  testId?: string;
}

export interface Line {
  // Replace the geometry: a single polyline (LngLat[]) or a set of features
  // (per-feature properties, e.g. color). Empty clears the line.
  set(geometry: LngLat[] | Feature[]): void;
  remove(): void;
}

export interface MarkerSpec {
  id: string;
  at: LngLat;
  // The consumer owns the DOM (pin SVG, endpoint dot), so all marker classes
  // and test ids come through unchanged. Used by the maplibre + fake backends.
  el: HTMLElement;
  // Render `el` as a lightweight custom marker even on native-marker backends,
  // instead of substituting a native pin balloon — for small on-the-line affor-
  // dances (the midpoint "+" handles) that a full balloon would be too heavy for.
  custom?: boolean;
  // Semantic color for backends that draw native markers (MapKit renders a
  // native pin balloon in this color instead of using `el`).
  color?: string;
  // Short text shown inside a native marker (MapKit's glyphText) — used to
  // number route pins 1, 2, 3… so the order (and direction) reads at a glance.
  label?: string;
  // Color of that glyph (MapKit's glyphColor). Defaults to near-black for the
  // numbered pins; endpoints override to white for the start/stop symbols.
  glyphColor?: string;
  anchor?: "center" | "bottom";
  onClick?: () => void;
  // Tap-to-SELECT (distinct from onClick's tap-to-act): the marker becomes the
  // selected one and STAYS selected/highlighted (MapKit's native grown pin);
  // `onDeselect` fires when it is deselected (another picked, or tapped away).
  // Unlike onClick/drag, a select-only marker is still reconciled in place, so
  // a renumber never tears it down (and never drops a live selection).
  onSelect?: () => void;
  onDeselect?: () => void;
  // When true the marker can be dragged. `onDrag` fires continuously with the
  // live position (redraw the route line without committing); `onDragEnd`
  // fires once with the final position (commit + persist).
  draggable?: boolean;
  onDrag?: (at: LngLat) => void;
  onDragEnd?: (at: LngLat) => void;
}

export interface MarkerLayer {
  // Replace the whole marker set. Markers persist across setBaseMap.
  set(markers: MarkerSpec[]): void;
  clear(): void;
}

export interface AircraftState {
  at: LngLat;
  heading: number; // degrees — the fix's course
}

export interface Aircraft {
  // Push the current frame; null hides the aircraft. Triggers a repaint.
  set(state: AircraftState | null): void;
  remove(): void;
}

export interface MapView {
  // The map's DOM container (`.map-container`) — for CSS hooks and the few
  // e2e data-attributes the app stamps on it.
  readonly el: HTMLElement;
  // Resolves once the first base map has painted.
  readonly ready: Promise<void>;
  // Whether this backend can show satellite imagery: MapKit always (Apple
  // imagery is free on the developer account), MapLibre only when the pilot
  // supplied their own MapTiler key. Pages hide the view toggle when false.
  readonly supportsSatellite: boolean;
  setBaseMap(base: MapViewKind): void;
  destroy(): void;

  // Camera — the only live, imperative surface. moveTo unifies
  // jump / ease / fly; omitted fields hold their current value.
  camera(): Camera;
  moveTo(to: Partial<Camera>, opts?: MoveOptions): void;
  // Always an instant jump (no caller animates a fit).
  fitBounds(bounds: Bounds, opts?: { padding?: number | Insets }): void;
  zoomRange(): { min: number; max: number };
  // While following, anchor pinch/scroll zoom at the padded center so it
  // never tugs the aircraft toward the cursor. null restores cursor anchor.
  lockZoomAnchor(anchor: "center" | null): void;

  // Content — declarative handles that survive setBaseMap.
  line(style: LineStyle): Line;
  markers(): MarkerLayer;
  aircraft(): Aircraft;

  on(gesture: Gesture, handler: (e: GestureEvent) => void): Unsub;
}

// The smallest [sw, ne] box covering the points, or null if there are none.
export function boundsOf(points: Iterable<LngLat>): Bounds | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lng, lat] of points) {
    if (lng < west) west = lng;
    if (lng > east) east = lng;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  if (west === Infinity) return null;
  return [
    [west, south],
    [east, north],
  ];
}
