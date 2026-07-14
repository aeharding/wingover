import { load } from "@apple/mapkit-loader";

// MapKit JS tokens are public by design (they live in the browser), scoped to
// mapkit_js and bound to an origin — MapKit only authorizes when the page's
// host matches. We carry one per origin and pick by hostname; localhost is the
// default so plain `vite` and the Tauri dev webview (devUrl localhost)
// authorize with no /etc/hosts or custom-domain setup. Override any with
// VITE_MAPKIT_TOKEN.
const MAPKIT_TOKENS: Record<string, string> = {
  localhost:
    "eyJraWQiOiJZUjQ5TThKODhHIiwidHlwIjoiSldUIiwiYWxnIjoiRVMyNTYifQ.eyJpc3MiOiJTWVRONDRVMlVOIiwiaWF0IjoxNzgzOTU3NjA2LCJvcmlnaW4iOiJsb2NhbGhvc3QiLCJzY29wZSI6Im1hcGtpdF9qcyJ9.rg9mnM9vmRGmDwups9hkhKVoSbMh9EuoNmB3N88ZBCyL7DBLuqQ8A4xoGVnqfqMmZPN6XI-X9DFo_5-U91ofpQ",
  "wingover.app":
    "eyJraWQiOiJVSk1UOUxaTktRIiwidHlwIjoiSldUIiwiYWxnIjoiRVMyNTYifQ.eyJpc3MiOiJTWVRONDRVMlVOIiwiaWF0IjoxNzgzOTU1MzAxLCJvcmlnaW4iOiJ3aW5nb3Zlci5hcHAiLCJzY29wZSI6Im1hcGtpdF9qcyJ9.saNioTkYy9g4sDu5njfh5YrdoHn82XrCC8M9vwKOvhoziw448czaqe2nGfNXB7MoqeuZuAc4Hfprx9dDQUNaYw",
};

function mapKitToken(): string {
  return (
    import.meta.env.VITE_MAPKIT_TOKEN ||
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
