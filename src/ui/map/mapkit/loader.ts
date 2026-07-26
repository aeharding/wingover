import { load } from "@apple/mapkit-loader";
import { withTimeout } from "es-toolkit";

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

// Long enough that a slow but working MapKit still wins on a poor connection,
// short enough that a pilot is not left staring at nothing.
const MAPKIT_LOAD_TIMEOUT_MS = 8000;

let ready: Promise<typeof mapkit> | null = null;

// Loads MapKit JS 6 via Apple's official npm loader (@apple/mapkit-loader):
// it injects the CDN bundle, loads the named libraries, initializes with the
// token, and sets the global `mapkit`. Resolves with it, ready to construct
// maps; rejects if the bundle fails to load (offline, blocked) so MapCanvas can
// fall back to MapLibre. Libraries: `map` (the interactive map), `annotations`
// (the pins + midpoint handles), and `overlays` (the flight/route polylines +
// their Style/LineGradient).
export function loadMapKit(): Promise<typeof mapkit> {
  // A rejected load is NOT cached: with the provider switchable at runtime,
  // one offline moment must not pin the session to the MapLibre fallback
  // after the network returns.
  // Bounded HERE rather than around the map construction, so a hang can only
  // ever mean "no MapKit" and never "half a MapKit": racing the constructed
  // view would leave the loser still building, injecting a second map into
  // the same container and overwriting its handle, with nobody holding it to
  // destroy. Failing at the loader means no map object is made at all, and
  // "falls back on failure" stays true because the failure now ARRIVES.
  ready ??= withTimeout(
    () =>
      load({
        token: mapKitToken(),
        libraries: ["map", "annotations", "overlays"],
      }),
    MAPKIT_LOAD_TIMEOUT_MS,
  ).then(
    () => mapkit,
    (error: unknown) => {
      ready = null;
      // Apple's loader finds an existing script tag by data-callback and
      // REUSES it rather than making a new one. After a failed load that tag
      // is still in the head with its error event long since fired, so the
      // next call attaches load/error listeners to a corpse and waits on
      // events that can never fire again — it hangs, forever.
      //
      // That is not a slow map, it is NO map: createBackend awaits this, so a
      // hang means the catch never runs and the MapLibre fallback never
      // happens. One offline failure would otherwise poison every map for the
      // life of the page. Reported from device: first offline entry drew fine,
      // every entry after it was blank.
      document
        .querySelector('script[data-callback="initMapKitLoaderV2"]')
        ?.remove();
      throw error;
    },
  );
  return ready;
}
