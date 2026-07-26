import type { Feature, FeatureCollection } from "geojson";
import type { LayerSpecification, StyleSpecification } from "maplibre-gl";

// The offline basemap: no network sources, so it needs no network. The track
// and waypoints are local data and must draw without one (issue #164). Also
// what ?map-style=blank and the e2e suite use.

export const GRATICULE_SOURCE = "graticule";
const GRATICULE_LAYER = "graticule";
const GRATICULE_OPACITY = 0.4;

// maplibre's style parser predates CSS Color 4, so this stays hex (the same
// constraint toSrgb works around in the maplibre adapter).
const GRATICULE_COLOR = "#727d8c";

// Degrees across a phone viewport: 360 spans 256*2^zoom CSS px and a phone is
// ~390 px wide. Aim for ~10 boxes across it.
const VIEWPORT_DEGREES = 548;
const TARGET_BOXES = 10;

// Grid levels are integers: level L means 2^L degrees between lines, so level
// L-1 always splits level L exactly in half.
//
// A halving ladder rather than 1-2-5, which matters twice: halving nests (5
// would subdivide to 2.5, but the next 1-2-5 rung is 2, so lines would jump)
// and it puts exactly one new line in each box instead of four. The cost is
// spacings that are powers of two in degrees rather than round decimals —
// fine for a grid that exists to show drift and scale, and worth revisiting
// only if the lines are ever labelled with coordinates.
function levelForZoom(zoom: number): number {
  // The first level COARSER than the target, so the level below it is the
  // subdivision currently fading in.
  return Math.ceil(Math.log2(VIEWPORT_DEGREES / TARGET_BOXES / 2 ** zoom));
}

// Levels kept in the source BELOW the one being subdivided. These extra lines
// are fully transparent at the current zoom, so both adding them (zooming in)
// and dropping them (zooming out) are invisible — which is the point: nothing
// the adapter does may be able to show up as a flicker.
const SPARE_LEVELS = 2;

export function graticuleBaseLevel(zoom: number): number {
  return levelForZoom(zoom) - SPARE_LEVELS;
}

// Zoom at which a level-0 line STARTS fading in; each level is one zoom apart.
// A line is solid once its own grid is the one in use, and fades over the
// zoom before that.
const FADE_ANCHOR = Math.log2(VIEWPORT_DEGREES / TARGET_BOXES) - 1;

// Coarsest and finest grids the style carries: level 6 is 64 degrees (the
// whole world) and -17 is about a metre. Nothing outside that is reachable.
const COARSEST_LEVEL = 6;
const FINEST_LEVEL = -17;

/**
 * One layer per grid level, each with a FIXED filter and a pure zoom curve.
 *
 * Deliberately static, and that is the whole design. Driving the fade from JS
 * meant three mechanisms with three different latencies: setPaintProperty
 * applies immediately, a filter change re-parses the source in a worker
 * (measured ~145ms, during which the OLD lines render under the NEW opacity),
 * and setData lands later still. Every combination of those glitches
 * somewhere, in one zoom direction or the other. Expressed this way maplibre
 * evaluates the fade itself, per frame, with nothing to race: no filter ever
 * changes, no paint property is ever set, and maplibre's default 300ms paint
 * transition never engages because nothing transitions.
 *
 * interpolate clamps outside its stops, so a level is invisible below its
 * fade and solid above it forever. The stops trace a cubic: imperceptible
 * while the parent box is still small, arriving over the second half of the
 * zoom, with no dead zone at either end.
 */
function graticuleLayer(level: number): LayerSpecification {
  const start = FADE_ANCHOR - level;
  return {
    id: `${GRATICULE_LAYER}-${level}`,
    type: "line",
    source: GRATICULE_SOURCE,
    filter: ["==", ["get", "lvl"], level],
    paint: {
      "line-color": GRATICULE_COLOR,
      // A whole pixel: a sub-pixel line is alpha-blended across the device
      // grid and shimmers as it crosses pixel boundaries on a pan.
      "line-width": 1,
      "line-opacity": [
        "interpolate",
        ["linear"],
        ["zoom"],
        start,
        0,
        start + 0.5,
        GRATICULE_OPACITY * 0.125,
        start + 0.75,
        GRATICULE_OPACITY * 0.42,
        start + 1,
        GRATICULE_OPACITY,
      ],
    },
  };
}

function graticuleLayers(): LayerSpecification[] {
  const layers: LayerSpecification[] = [];
  for (let level = COARSEST_LEVEL; level >= FINEST_LEVEL; level--) {
    layers.push(graticuleLayer(level));
  }
  return layers;
}

// The coarsest grid a line belongs to. A line every 2^base degrees also
// belongs to 2^(base+1) when its index is even, and so on — so this is a
// property of the meridian itself, identical however the geometry was
// generated. That is what lets regeneration be invisible: a line already on
// screen keeps its level, and only never-yet-visible lines are added.
function levelOfIndex(index: number): number {
  if (index === 0) return COARSEST_LEVEL; // equator / prime meridian
  let steps = 0;
  let n = Math.abs(index);
  while (n % 2 === 0) {
    n /= 2;
    steps++;
  }
  return steps;
}

/**
 * Meridians and parallels covering `bounds` at 2^baseLevel spacing, each
 * tagged with the coarsest level it belongs to.
 *
 * Indices are integers and coordinates derive from them, so nothing
 * accumulates floating-point drift the way repeatedly adding a 0.001 step
 * would over a few hundred lines.
 */
export function graticuleFeatures(
  bounds: { w: number; e: number; s: number; n: number },
  baseLevel: number,
): FeatureCollection {
  const step = 2 ** baseLevel;
  const features: Feature[] = [];
  const push = (
    index: number,
    from: [number, number],
    to: [number, number],
  ) => {
    features.push({
      type: "Feature",
      properties: {
        lvl: Math.min(COARSEST_LEVEL, baseLevel + levelOfIndex(index)),
      },
      geometry: { type: "LineString", coordinates: [from, to] },
    });
  };

  for (let i = Math.floor(bounds.w / step); i * step <= bounds.e; i++) {
    push(i, [i * step, bounds.s], [i * step, bounds.n]);
  }
  for (let j = Math.floor(bounds.s / step); j * step <= bounds.n; j++) {
    push(j, [bounds.w, j * step], [bounds.e, j * step]);
  }
  return { type: "FeatureCollection", features };
}

// The graticule is not decoration. On an empty background a moving map reads
// as a still one and zoom carries no scale, so these lines are the only
// reference the pilot has for distance and drift. The adapter feeds the
// source (it is the side that knows the viewport); an unfed source simply
// draws nothing.
export const BLANK_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    [GRATICULE_SOURCE]: {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    },
  },
  layers: [
    {
      id: "background",
      type: "background",
      paint: { "background-color": "#191b1e" },
    },
    ...graticuleLayers(),
  ],
};
