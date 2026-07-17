import type {
  RasterSourceSpecification,
  StyleSpecification,
} from "maplibre-gl";

import { getSetting } from "../../storage/local";

export type MapViewKind = "street" | "satellite";

// The keyless street fallback: OpenFreeMap's hosted dark style — free,
// no account, no quota to bill anyone. MapLibre is the FALLBACK backend
// (MapKit is the default everywhere) and is allowed to be plainer; nothing
// first-party may cost money here.
const OPENFREEMAP_DARK_STYLE = "https://tiles.openfreemap.org/styles/dark";

// Street view: MapTiler Streets v4 dark for pilots who brought their own
// key (vector, labels stay upright in track-up), OpenFreeMap otherwise.
function streetStyleUrl(key: string | null): string {
  return key
    ? `https://api.maptiler.com/maps/streets-v4-dark/style.json?key=${key}`
    : OPENFREEMAP_DARK_STYLE;
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
// (how e2e forces the fake, deterministic, network-free backend), then the
// blank debug style (implies MapLibre for offline manual debugging), then
// the pilot's Settings choice.
export async function resolveBackend(): Promise<MapBackend> {
  const override = backendOverride();
  if (override === "mapkit" || override === "maplibre" || override === "fake") {
    return override;
  }
  if (blankStyleRequested()) return "maplibre";
  const chosen = await getSetting("mapBackend");
  if (chosen === "mapkit" || chosen === "maplibre") return chosen;
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

// The pilot's own MapTiler key, or null. There is deliberately no built-in
// key and no build-time env fallback: satellite is MapKit's job (free on the
// Apple developer account), and MapLibre satellite exists only for pilots
// who bring their own key. First-party map costs are zero by construction.
export async function resolveMaptilerKey(): Promise<string | null> {
  return (await getSetting("maptilerKey")) || null;
}

// Satellite view is MapTiler's Hybrid style: satellite imagery under the
// style's own VECTOR road + label layers. Vector labels stay upright when
// the map rotates (track-up) — the pre-baked hybrid RASTER tiles rotate
// their text with the imagery, which is unreadable. We keep the style's
// vector overlay, glyphs, and sprite as-is and only swap its standard-res
// satellite-v2 source for @2x maps/satellite tiles: 1024px per tile (~2x
// the source pixels per screen pixel, the Apple-Maps sharpness
// difference) up to maxzoom 22. @3x/@4x are not offered (HTTP 400).
async function satelliteStyle(
  key: string,
): Promise<StyleSpecification | string> {
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
  const key = await resolveMaptilerKey();
  // No key, no satellite (a stored "satellite" preference degrades to
  // street rather than erroring) — the toggle is hidden in that state via
  // MapView.supportsSatellite.
  if (view === "street" || !key) return streetStyleUrl(key);
  return satelliteStyle(key);
}
