// MapKit JS tokens are public by design (they live in the browser), scoped to
// mapkit_js and bound to an origin — MapKit only authorizes when the page's
// host matches. We carry one per origin and pick by hostname; localhost is
// the default so plain `vite` and the Tauri dev webview (devUrl localhost)
// authorize with no /etc/hosts or custom-domain setup. Override any with
// VITE_MAPKIT_TOKEN.
const MAPKIT_TOKENS: Record<string, string> = {
  localhost:
    "eyJraWQiOiJZUjQ5TThKODhHIiwidHlwIjoiSldUIiwiYWxnIjoiRVMyNTYifQ.eyJpc3MiOiJTWVRONDRVMlVOIiwiaWF0IjoxNzgzOTU3NjA2LCJvcmlnaW4iOiJsb2NhbGhvc3QiLCJzY29wZSI6Im1hcGtpdF9qcyJ9.rg9mnM9vmRGmDwups9hkhKVoSbMh9EuoNmB3N88ZBCyL7DBLuqQ8A4xoGVnqfqMmZPN6XI-X9DFo_5-U91ofpQ",
  "wingover.local":
    "eyJraWQiOiI2R0s2Ukc2NFI5IiwidHlwIjoiSldUIiwiYWxnIjoiRVMyNTYifQ.eyJpc3MiOiJTWVRONDRVMlVOIiwiaWF0IjoxNzgzOTU1MzAxLCJvcmlnaW4iOiJ3aW5nb3Zlci5sb2NhbCIsInNjb3BlIjoibWFwa2l0X2pzIn0.EehJP9hXzH8c_Uhn4Oop2JbeuYIojzFWmfANJKcmz8abhOIPi4CDVIsui6057F-ii_Tm3V5uJd-aTq0K91B7KQ",
};

function mapKitToken(): string {
  return (
    import.meta.env.VITE_MAPKIT_TOKEN ||
    MAPKIT_TOKENS[location.hostname] ||
    MAPKIT_TOKENS.localhost
  );
}

// The stable MapKit JS bundle. The core Map/overlay/annotation API the
// adapter uses is unchanged across v5/v6; to move to the modular v6 loader
// (data-libraries / @apple/mapkit-loader) swap only this function.
const MAPKIT_SRC = "https://cdn.apple-mapkit.com/mk/5.x.x/mapkit.js";

let ready: Promise<typeof mapkit> | null = null;

// Injects MapKit JS once and initializes it with the token. Resolves with the
// global `mapkit`, ready to construct maps. Rejects if the script fails to
// load (offline, blocked) so MapCanvas can fall back to MapLibre.
export function loadMapKit(): Promise<typeof mapkit> {
  if (ready) return ready;
  ready = new Promise((resolve, reject) => {
    const init = () => {
      mapkit.init({ authorizationCallback: (done) => done(mapKitToken()) });
      resolve(mapkit);
    };
    if (typeof mapkit !== "undefined") {
      init();
      return;
    }
    const existing = document.getElementById("mapkit-js");
    if (existing) {
      existing.addEventListener("load", init, { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error("MapKit JS failed to load")),
        { once: true },
      );
      return;
    }
    const script = document.createElement("script");
    script.id = "mapkit-js";
    script.src = MAPKIT_SRC;
    script.crossOrigin = "anonymous";
    script.async = true;
    script.addEventListener("load", init, { once: true });
    script.addEventListener(
      "error",
      () => reject(new Error("MapKit JS failed to load")),
      { once: true },
    );
    document.head.appendChild(script);
  });
  return ready;
}
