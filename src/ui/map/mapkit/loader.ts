import { load } from "@apple/mapkit-loader";

const MAPKIT_TOKENS: Record<string, string> = {
  localhost: import.meta.env.VITE_MAPKIT_TOKEN_LOCALHOST,
  "wingover.app": import.meta.env.VITE_MAPKIT_TOKEN_WINGOVER_APP,
  "tauri://localhost": import.meta.env.VITE_MAPKIT_TOKEN_TAURI,
};

function mapKitToken(): string {
  return (
    import.meta.env.VITE_MAPKIT_TOKEN ||
    MAPKIT_TOKENS[location.origin] ||
    MAPKIT_TOKENS[location.hostname] ||
    MAPKIT_TOKENS.localhost
  );
}

let ready: Promise<typeof mapkit> | null = null;

// Loads MapKit JS 6 via Apple's official npm loader (@apple/mapkit-loader):
// it injects the CDN bundle, loads the named libraries, initializes with the
// token, and sets the global `mapkit`. Resolves with it, ready to construct
// maps; rejects if the bundle fails to load (offline, blocked) so MapCanvas can
// fall back to MapLibre. Libraries: `map` (the interactive map), `annotations`
// (the pins + midpoint handles), and `overlays` (the flight/route polylines +
// their Style/LineGradient).
export function loadMapKit(): Promise<typeof mapkit> {
  ready ??= load({
    token: mapKitToken(),
    libraries: ["map", "annotations", "overlays"],
  }).then(() => mapkit);
  return ready;
}
