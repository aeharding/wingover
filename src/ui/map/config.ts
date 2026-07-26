import type {
  RasterSourceSpecification,
  StyleSpecification,
} from "maplibre-gl";

import { getSetting } from "../../storage/local";
import { NO_BASEMAP_STYLE } from "./noBasemapStyle";

export type MapViewKind = "street" | "satellite";

// Which world the basemap lives in. Ground screens (logbook, plan, detail,
// desktop PWA) follow the system scheme like the rest of the app
// (useSystemAppearance); the LIVE flight map is always light — full sun on
// a leg-mounted phone is the one place a dark map loses. A per-context
// rule, deliberately not a setting.
export type MapAppearance = "light" | "dark";

// The keyless street fallbacks: OpenFreeMap's hosted styles — free, no
// account, no quota to bill anyone. MapLibre is the FALLBACK backend
// (MapKit is the default everywhere) and is allowed to be plainer; nothing
// first-party may cost money here.
const OPENFREEMAP_STYLES: Record<MapAppearance, string> = {
  dark: "https://tiles.openfreemap.org/styles/dark",
  light: "https://tiles.openfreemap.org/styles/liberty",
};

// Street view: MapTiler Streets v4 for pilots who brought their own key
// (vector, labels stay upright in track-up), OpenFreeMap otherwise.
function streetStyleUrl(key: string | null, appearance: MapAppearance): string {
  return key
    ? `https://api.maptiler.com/maps/${
        appearance === "dark" ? "streets-v4-dark" : "streets-v4"
      }/style.json?key=${key}`
    : OPENFREEMAP_STYLES[appearance];
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
  appearance: MapAppearance,
): Promise<StyleSpecification | null> {
  const style = await fetchStyle(
    `https://api.maptiler.com/maps/hybrid-v4/style.json?key=${key}`,
  );
  if (!style?.sources) {
    console.warn(
      "Satellite unavailable (MapTiler hybrid style — key not valid for this origin); showing street view",
    );
    return fetchStyle(streetStyleUrl(key, appearance));
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

// Fetched here rather than handed to maplibre as a URL, so that a style we
// cannot reach is a value the caller can SEE. Given a URL, maplibre fetches it
// itself and a failure leaves the map with no style at all — which takes the
// track down with it, because the overlay registry runs on style.load. The
// satellite path already worked this way; this makes street match it.
//
// Safe to hand back a parsed object: OpenFreeMap's styles use absolute URLs
// for sprite, glyphs and every source, so nothing resolves relative to the
// style URL we just dropped.

// A connection that black-holes rather than refusing (dying signal; iOS waits
// ~60s) would otherwise leave the map with no style object at all. The catch
// below turns the abort into null, which is the point of the contract: a hang
// becomes NO_BASEMAP_STYLE plus a retry, not a blank screen.
const STYLE_FETCH_TIMEOUT_MS = 8000;

async function fetchStyle(url: string): Promise<StyleSpecification | null> {
  return fetch(url, { signal: AbortSignal.timeout(STYLE_FETCH_TIMEOUT_MS) })
    .then((response) =>
      response.ok ? (response.json() as Promise<StyleSpecification>) : null,
    )
    .catch(() => null);
}

/**
 * The basemap style, or null when there is no reaching it.
 *
 * null is the whole contract: callers decide what an unreachable basemap
 * means. At construction it means NO_BASEMAP_STYLE (a map that always loads, so the
 * track always has somewhere to live); on a later swap it means keep what is
 * already up, because a failed satellite toggle must not blank a working
 * street map.
 */
export async function resolveMapStyle(
  view: MapViewKind,
  appearance: MapAppearance,
): Promise<StyleSpecification | null> {
  // Asked for, not failed — so it is a real answer, and never retried.
  if (blankStyleRequested()) return NO_BASEMAP_STYLE;
  const key = await resolveMaptilerKey();
  // No key, no satellite (a stored "satellite" preference degrades to
  // street rather than erroring) — the toggle is hidden in that state via
  // MapView.supportsSatellite.
  if (view === "street" || !key) {
    return fetchStyle(streetStyleUrl(key, appearance));
  }
  return satelliteStyle(key, appearance);
}
