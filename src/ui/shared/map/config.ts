import { getSetting } from "../../../storage/local";

// "chart" is street + the FAA sectionals on top (useChartOverlay): the
// basemap still shows through open water and outside US coverage, which
// is exactly where the sectional has nothing to say.
export type MapViewKind = "street" | "satellite" | "chart";

// The two views every map offers. Ground maps may add "chart" on top
// (useGroundMapViews); the flight surface never does.
export const BASE_VIEWS: MapViewKind[] = ["street", "satellite"];

// Which world the basemap lives in. Ground screens (logbook, plan, detail,
// desktop PWA) follow the system scheme like the rest of the app
// (useSystemAppearance); the LIVE flight map is always light — full sun on
// a leg-mounted phone is the one place a dark map loses. A per-context
// rule, deliberately not a setting.
export type MapAppearance = "light" | "dark";

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

// Read from both sides of the seam: it picks the backend here, and picks the
// style over in maplibre/style.ts. It stays with the launch flags it is one of.
export function blankStyleRequested(): boolean {
  return launchParam("map-style") === "blank";
}

export type MapBackend = "mapkit" | "maplibre";

// MapKit JS is the default map backend everywhere — its token authorizes on
// localhost, so plain `vite` and the Tauri dev webview get it too. Overrides,
// highest first: ?map= in the URL, then a "wingover.map" localStorage flag,
// then ?map-style=blank (which implies MapLibre, since the no-basemap style is
// a maplibre style), then the pilot's Settings choice.
export async function resolveBackend(): Promise<MapBackend> {
  const override = backendOverride();
  if (override === "mapkit" || override === "maplibre") return override;
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
