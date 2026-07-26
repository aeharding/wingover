import type { StyleSpecification } from "maplibre-gl";

// The offline basemap: no sources at all, so it needs no network. The track
// and waypoints are local data and must draw without one (issue #164). Also
// what ?map-style=blank and the e2e suite use.
//
// Just a background. The grid over it is a WebGL custom layer the adapter
// adds (maplibre/graticule.ts): a custom layer cannot live in a
// StyleSpecification, and it should not. On an empty background a moving map
// reads as a still one and zoom carries no scale, so those lines are the only
// reference the pilot has for distance and drift — and on a map that follows
// the aircraft for hours they have to be nearly free to draw.
export const GRATICULE_LAYER = "graticule";
export const NO_BASEMAP_BACKGROUND_LAYER = "background";

// Matches the container backdrop in map.module.css, so an unreachable basemap
// looks like a deliberately empty map rather than a broken one. Two values
// because the ground screens follow the system scheme; the blank style used to
// be dark always, which read as "light mode is broken".
export const NO_BASEMAP_BACKGROUND: Record<"light" | "dark", string> = {
  dark: "#191b1e",
  light: "#e2e5e9",
};

export const NO_BASEMAP_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [
    {
      id: "background",
      type: "background",
      paint: { "background-color": "#191b1e" },
    },
  ],
};
