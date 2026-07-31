import type {
  RasterSourceSpecification,
  StyleSpecification,
} from "maplibre-gl";

import { getSetting } from "../../../../storage/local";
import {
  blankStyleRequested,
  type MapAppearance,
  type MapViewKind,
} from "../config";
import { NO_BASEMAP_STYLE } from "./noBasemapStyle";

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
async function satelliteStyle(key: string): Promise<StyleSpecification | null> {
  const style = await fetchStyle(
    `https://api.maptiler.com/maps/hybrid-v4/style.json?key=${key}`,
  );
  if (!style?.sources) {
    console.warn(
      "Satellite unavailable (MapTiler hybrid style — key not valid for this origin)",
    );
    return null;
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

// A connection that black-holes rather than refusing would otherwise leave the
// map with no style at all. The catch below turns the abort into null, so a
// hang becomes NO_BASEMAP_STYLE plus a retry rather than a blank screen.
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
 * null is the whole contract: callers decide what nothing-to-show means. The
 * adapter answers it with the no-basemap grid when the pilot asked for this
 * view, and by keeping what is already up when they did not, then retries.
 */
export async function resolveMapStyle(
  view: MapViewKind,
  appearance: MapAppearance,
): Promise<StyleSpecification | null> {
  // Asked for, not failed — so it is a real answer, and never retried.
  if (blankStyleRequested()) return NO_BASEMAP_STYLE;
  const key = await resolveMaptilerKey();
  // Chart rides the street basemap; the sectional raster goes on top.
  if (view !== "satellite") return fetchStyle(streetStyleUrl(key, appearance));
  // Satellite is the pilot's own MapTiler key or nothing. Answering with
  // street would be the map showing a view nobody asked for; null gets the
  // grid instead, and the caller's retry picks a key up if one arrives.
  return key ? satelliteStyle(key) : null;
}
