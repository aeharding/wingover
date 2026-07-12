import type {
  RasterSourceSpecification,
  StyleSpecification,
} from "maplibre-gl";

import { getSetting } from "../../storage/db";

export type MapViewKind = "street" | "satellite";

const DEFAULT_MAPTILER_KEY = "o4oQEM4UgYvcVV6NYfpr";

export const STREET_STYLE_URL = "https://tiles.openfreemap.org/styles/dark";

const initialSearch = location.search;

function blankStyleRequested(): boolean {
  return new URLSearchParams(initialSearch).get("map-style") === "blank";
}

const BLANK_STYLE: StyleSpecification = {
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

export async function resolveMaptilerKey(): Promise<string> {
  return (
    (await getSetting("maptilerKey")) ||
    import.meta.env.VITE_MAPTILER_KEY ||
    DEFAULT_MAPTILER_KEY
  );
}

// Satellite view is MapTiler's Hybrid style: satellite imagery under the
// style's own VECTOR road + label layers. Vector labels stay upright when
// the map rotates (track-up) — the pre-baked hybrid RASTER tiles rotate
// their text with the imagery, which is unreadable. We keep the style's
// vector overlay, glyphs, and sprite as-is and only swap its standard-res
// satellite-v2 source for @2x maps/satellite tiles: 1024px per tile (~2x
// the source pixels per screen pixel, the Apple-Maps sharpness
// difference) up to maxzoom 22. @3x/@4x are not offered (HTTP 400).
async function satelliteStyle(): Promise<StyleSpecification | string> {
  const key = await resolveMaptilerKey();
  const style = await fetch(
    `https://api.maptiler.com/maps/hybrid-v4/style.json?key=${key}`,
  )
    .then((response) =>
      response.ok ? (response.json() as Promise<StyleSpecification>) : null,
    )
    .catch(() => null);
  if (!style?.sources) {
    console.warn(
      "Satellite unavailable (MapTiler hybrid style — key not valid for this origin); showing street view",
    );
    return STREET_STYLE_URL;
  }

  const base = style.sources.satellite;
  if (base?.type === "raster") {
    const retina: RasterSourceSpecification = {
      type: "raster",
      tiles: [
        `https://api.maptiler.com/maps/satellite/{z}/{x}/{y}@2x.jpg?key=${key}`,
      ],
      tileSize: 512,
      maxzoom: 22,
      attribution: base.attribution,
    };
    style.sources = { ...style.sources, satellite: retina };
  }
  return style;
}

export async function resolveMapStyle(
  view: MapViewKind,
): Promise<StyleSpecification | string> {
  if (blankStyleRequested()) return BLANK_STYLE;
  if (view === "street") return STREET_STYLE_URL;
  return satelliteStyle();
}
