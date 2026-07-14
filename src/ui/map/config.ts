import type {
  RasterSourceSpecification,
  StyleSpecification,
} from "maplibre-gl";

import { getSetting } from "../../storage/db";

export type MapViewKind = "street" | "satellite";

const DEFAULT_MAPTILER_KEY = "o4oQEM4UgYvcVV6NYfpr";

// Street view is MapTiler Streets v4 (vector, so labels stay upright when
// the map rotates in track-up). maplibre loads the style.json URL
// directly; no fetch/merge needed (unlike satellite). streets-v4 is the
// light variant, streets-v4-dark the dark one.
function streetStyleUrl(key: string): string {
  return `https://api.maptiler.com/maps/streets-v4-dark/style.json?key=${key}`;
}

// Launch-only URL flags (e.g. ?map-style=blank) must be read at app entry,
// before the SPA router strips the query string. The map — and therefore
// this module — loads lazily, so main.tsx calls captureLaunchUrl() eagerly
// to pin the value; we fall back to the live search if that never ran.
let launchSearch: string | null = null;

export function captureLaunchUrl() {
  if (launchSearch === null) launchSearch = location.search;
}

export function launchParam(name: string): string | null {
  return new URLSearchParams(launchSearch ?? location.search).get(name);
}

function blankStyleRequested(): boolean {
  return launchParam("map-style") === "blank";
}

export type MapBackend = "mapkit" | "maplibre" | "fake";

// MapKit JS is the default map backend everywhere — its token authorizes on
// localhost, so plain `vite` and the Tauri dev webview get it too. Overrides
// (highest first): ?map= in the URL, then a "wingover.map" localStorage flag
// (how e2e forces the fake, deterministic, network-free backend). The blank
// debug style still implies MapLibre for offline manual debugging.
export function resolveBackend(): MapBackend {
  const override = backendOverride();
  if (override === "mapkit" || override === "maplibre" || override === "fake") {
    return override;
  }
  if (blankStyleRequested()) return "maplibre";
  return "mapkit";
}

function backendOverride(): string | null {
  const param = launchParam("map");
  if (param) return param;
  try {
    return localStorage.getItem("wingover.map");
  } catch {
    return null;
  }
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
    return streetStyleUrl(key);
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
  if (view === "street") return streetStyleUrl(await resolveMaptilerKey());
  return satelliteStyle();
}
