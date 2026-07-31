import { load } from "@apple/mapkit-loader";

const MAPKIT_TOKENS: Record<string, string> = {
  localhost: import.meta.env.VITE_MAPKIT_TOKEN_LOCALHOST,
  "wingover.app": import.meta.env.VITE_MAPKIT_TOKEN_WINGOVER_APP,
  "beta.wingover.app": import.meta.env.VITE_MAPKIT_TOKEN_BETA_WINGOVER_APP,
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

// Mirrors Apple's private CALLBACK_NAME; a rename there surfaces as a drill
// failure rather than the hang returning.
const LOADER_CALLBACK = "initMapKitLoaderV2";

let ready: Promise<typeof mapkit> | null = null;

// Loads MapKit JS 6 via Apple's official npm loader (@apple/mapkit-loader):
// it injects the CDN bundle, loads the named libraries, initializes with the
// token, and sets the global `mapkit`. Resolves with it, ready to construct
// maps; rejects if the bundle fails to load (offline, blocked) so MapCanvas can
// fall back to MapLibre. Libraries: `map` (the interactive map), `annotations`
// (the pins + midpoint handles), and `overlays` (the flight/route polylines +
// their Style/LineGradient).
// Apple's loader reuses an existing tag, so one whose `error` already fired
// hangs the next call forever. Only remove it when no namespace appeared: a
// second mapkit.core.js overwrites `window.mapkit`, and overlays from the new
// namespace throw when passed to a map built from the old one.
function cleanupLoaderTagIfNeeded() {
  if ("mapkit" in window) return;
  document
    .querySelector(`script[data-callback="${LOADER_CALLBACK}"]`)
    ?.remove();
}

export function loadMapKit(): Promise<typeof mapkit> {
  // A rejected load is NOT cached: with the provider switchable at runtime,
  // one offline moment must not pin the session to the MapLibre fallback
  // after the network returns.
  ready ??= load({
    token: mapKitToken(),
    libraries: ["map", "annotations", "overlays"],
  }).then(
    () => mapkit,
    (error: unknown) => {
      ready = null;
      cleanupLoaderTagIfNeeded();
      throw error;
    },
  );
  return ready;
}
