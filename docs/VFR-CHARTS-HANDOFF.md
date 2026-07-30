# VFR charts: app-integration handoff

Scope of this doc: the WINGOVER APP side of self-hosted FAA VFR chart
tiles. The tile pipeline (repo `aeharding/charts.wingover.app`) is owned
by another workstream; its output is the interface described below. Do
not modify the pipeline repo from this workstream.

## What exists and works today

- The full FAA VFR product is baked and served: 53 CONUS sectionals +
  Alaska + Hawaii + Caribbean + Marianas + Samoa + both Aleutian halves,
  as one seamless tile pyramid. ~553k JPEG XL tiles.
- Serving: `https://charts.wingover.app/vfr/<prefix>/3x/{z}/{x}/{y}.jxl`
  behind Cloudflare (cache rule + WAF referer allowlist). Tiles are
  immutable-cached; every bake ships to a NEW prefix, never in place.
- Tiles are @3x only: 768px images on the standard XYZ grid, JXL d4/e7,
  z0-12. No @2x set exists by decision; lower-dpr devices supersample.
- This worktree (`feat/vfr-sectional-poc`, UNCOMMITTED) has the working
  overlay: `src/ui/pages/PlanPage.tsx` calls `rasterOverlay(...)` with a
  hardcoded prefix URL and a near-global coverage box.

## The interface: latest.json (being built pipeline-side NOW)

The prefix naming is being reworked (away from letter suffixes) and a
manifest will become the one source of truth at:

    https://charts.wingover.app/vfr/latest.json

Treat its `tiles` template fields as authoritative rather than building
URLs from parts. Expected shape (confirm against the live file; the
pipeline workstream may extend it):

```json
{
  "current": {
    "cycle": "2026-07-09",
    "tiles": "https://charts.wingover.app/vfr/<prefix>/3x/{z}/{x}/{y}.jxl",
    "minZoom": 0,
    "maxZoom": 12,
    "effective": "2026-07-09T09:01:00Z",
    "baked": "<ISO timestamp>"
  },
  "next": null
}
```

**Pre-effective cycles:** the FAA publishes each new cycle's files ~20
days before they take force, and the pipeline bakes them as soon as they
appear. A not-yet-effective bake arrives as `next` (same shape,
`effective` in the future). The CLIENT picks: use `next` when
`now >= next.effective`, else `current`. Never show a not-yet-effective
chart as the chart. The pipeline also promotes `next` to `current`
server-side at the effective moment, so clients that only read `current`
degrade to at-most-stale, never to premature. Charts go effective at
0901Z on the effective date.

latest.json is NOT immutable-cached (short TTL). Until it ships, the
hardcoded prefix in PlanPage.tsx is the temporary pointer; the pipeline
side keeps it working but WILL eventually expire old prefixes (bucket
lifecycle deletes vfr objects after 180 days), so manifest resolution is
the first integration task, not an optional polish.

## App work, in priority order

1. **Manifest resolution.** Fetch latest.json (once per app session is
   fine; it changes at most every few days), feed the `tiles` template
   into `rasterOverlay`. Handle fetch failure by not showing the layer
   (no error banner; charts are an enhancement). Kill the hardcoded URL.
2. **Chart toggle.** A third map view mode (decided direction; see
   `settings-ui-voyager-pattern` and STEERING.md before building any
   UI). Online charts are free/public-data by stance; offline packs are
   the future paid feature (SYNC-UX: Subscription = services).
3. **JXL feature-detect.** Native decode only, by decision: iOS/Safari
   17+ yes, Chromium only behind its flag, Firefox stable no. Detect
   (decode a 1px JXL data URL) and hide the toggle/layer cleanly where
   unsupported. No WASM fallback, no AVIF, no FAA-host fallback.
4. **Currency line.** Show cycle/effective date from latest.json where
   the toggle lives. FAA republishes every 56 days.
5. **Land the branch.** This worktree is uncommitted by prior
   convention. When integration is real: branch + PR (NEVER push main;
   every main merge burns a limited TestFlight build), full local gates
   first (`tsc --noEmit`, `eslint . --max-warnings 0`, `format:check`,
   `check:css`, `vitest`, `playwright`).

## Load-bearing constraints (violating these reopens settled decisions)

- MapKit stays the chart renderer. Its TileOverlay cannot overzoom, so
  the mapkit adapter uses the async image-callback form (fetch + <img>
  decode + canvas), and past z12 it crops+upscales the z12 ancestor
  client-side. Consequence: the tile host must send CORS headers even
  for MapKit — already configured, GET only.
- MapKit resolves a tile 404 to a transparent tile ONCE and caches it;
  MapLibre doesn't retry 404s. Ocean tiles inside the coverage box 404
  by design (blank-skipped server-side). Don't "fix" this.
- The coverage box in PlanPage.tsx is deliberately near-global: the
  product spans the antimeridian (Marianas 145E to Virgin Islands 60W,
  Samoa 14S to Point Barrow 72N), so no single tight box exists.
  Precise coverage arrives via the manifest when the pipeline adds it.
- Pilot-facing strings: no em dashes. Colors: display-p3, no sRGB
  fallbacks. Settings UI: stock Ionic idiom.
- `src/ui/` buckets: PlanPage is `app/`-side. Nothing here may import
  from `flight/` (`wingover/ui-bucket-isolation`).

## Verification (this is the part that bites)

- Desktop browsers cannot decode JXL. Chart rendering is verified on an
  iPhone (Safari/WKWebView, iOS 17+) pointed at the dev server, or in
  desktop Safari 17+. Playwright uses the fake map backend and never
  exercises tiles.
- Port 5173 must serve THIS worktree — check the listener's cwd via
  /proc before trusting phone feedback; a stale vite from another
  worktree has burned hours before.
- Cloudflare WAF allows referers starting with `http://localhost:` (any
  port). A LAN address like `http://192.168.x.x:5173` is NOT allowlisted;
  test via localhost or expect 403s.
- Stale Safari bundles survive dev-server swaps; retest in a private tab
  before believing a failure.
- First loads on a fresh prefix are cache-cold at the edge; slow first
  pans are normal.

## Pointers

- Pipeline repo: `~/charts.wingover.app` (local clone), GitHub
  `aeharding/charts.wingover.app`. Its README/scripts are the reference
  for what the tiles contain. Heavy rendering runs on the mac
  (`ssh mac`) in the `ghcr.io/osgeo/gdal:ubuntu-full-latest` container.
- Map abstraction: `src/ui/map/` — `MapView` interface, mapkit +
  maplibre + fake adapters. CSS-order and launch-URL load-order gotchas
  are real; see the `map-view-abstraction` memory and git history.
- Auto-memory has the full decision trail: `vfr-charts-project`,
  `mapkit-js-gotchas`, `charts-furniture-over-neighbour`,
  `verify-ui-visually`, `stale-5173-dev-server`.
