import type { StyleSpecification, SymbolLayerSpecification } from "maplibre-gl";

import { getSetting } from "../storage/db";

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

async function satelliteStyle(): Promise<StyleSpecification | string> {
  const key = await resolveMaptilerKey();
  const tileJsonUrl = `https://api.maptiler.com/tiles/satellite-v2/tiles.json?key=${key}`;

  const probe = await fetch(tileJsonUrl).catch(() => null);
  if (!probe?.ok) {
    console.warn(
      `Satellite unavailable (MapTiler ${probe ? probe.status : "network error"} — key not valid for this origin); showing street view`,
    );
    return STREET_STYLE_URL;
  }

  const satelliteSource = {
    type: "raster" as const,
    url: tileJsonUrl,
    attribution:
      '© <a href="https://www.maptiler.com/">MapTiler</a> © OpenStreetMap contributors',
  };
  const backgroundLayer = {
    id: "background",
    type: "background" as const,
    paint: { "background-color": "#191b1e" },
  };
  const satelliteLayer = {
    id: "satellite",
    type: "raster" as const,
    source: "satellite",
  };

  try {
    const response = await fetch(STREET_STYLE_URL);
    const street = (await response.json()) as StyleSpecification;
    return {
      ...street,
      sources: { ...street.sources, satellite: satelliteSource },
      layers: [
        backgroundLayer,
        satelliteLayer,
        ...street.layers
          .filter(
            (layer): layer is SymbolLayerSpecification =>
              layer.type === "symbol",
          )
          .map((layer) => ({
            ...layer,
            paint: {
              ...layer.paint,
              "text-color": "#ffffff",
              "text-halo-color": "rgba(0, 0, 0, 0.75)",
              "text-halo-width": 1.4,
              "text-halo-blur": 0.5,
            },
          })),
      ],
    };
  } catch {
    return {
      version: 8,
      sources: { satellite: satelliteSource },
      layers: [backgroundLayer, satelliteLayer],
    };
  }
}

export async function resolveMapStyle(
  view: MapViewKind,
): Promise<StyleSpecification | string> {
  if (blankStyleRequested()) return BLANK_STYLE;
  if (view === "street") return STREET_STYLE_URL;
  return satelliteStyle();
}
