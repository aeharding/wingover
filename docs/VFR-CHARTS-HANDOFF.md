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
- The app side is PR #216 off `feat/vfr-sectional-poc`: raster overlays on
  both map backends, manifest resolution, a third "chart" view mode, and a
  JXL feature gate. See "App work" below for what each commit did.

## The interface: latest.json

The one pointer that moves, and the only thing the app trusts:

    https://charts.wingover.app/vfr/latest.json

Expected shape (what the app parses):

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

`tiles` may be relative to the manifest; the app resolves it (and repairs
the braces, which WHATWG URL percent-encodes). `minZoom`/`maxZoom` are
required: past maxZoom the adapters crop and upscale the deepest ancestor
rather than requesting tiles that were never baked, so a release without
them is rejected. `cycle` and `effective` are optional to the parser, but
`effective` is what the pre-effective rule runs on.

**Pre-effective cycles:** the FAA publishes each new cycle's files ~20
days before they take force, and the pipeline bakes them as soon as they
appear. A not-yet-effective bake arrives as `next` (same shape,
`effective` in the future). The CLIENT picks: use `next` when
`now >= next.effective`, else `current`. Never show a not-yet-effective
chart as the chart. The pipeline also promotes `next` to `current`
server-side at the effective moment, so clients that only read `current`
degrade to at-most-stale, never to premature. Charts go effective at
0901Z on the effective date.

latest.json is NOT immutable-cached (short TTL).

### Open questions for the pipeline workstream (as of 2026-07-30)

1. **RESOLVED 2026-07-30.** The stale file you saw was the v1-era
   manifest pinned in Cloudflare's cache by its own immutable header;
   Alex purged the URL. A plain GET now returns the contract shape with
   `current.tiles` = `.../vfr/07-09-2026k/3x/{z}/{x}/{y}.jxl` and
   `max-age=300`. The pipeline publishes this file only after a bake's
   verify job passes, and a daily 0906Z cron promotes `next` at its
   effective moment. Re-test the app's manifest path with no overrides;
   it should just work now.
2. **CORS is an exact-origin allowlist, and the app fetches tiles with
   `fetch()`.** Measured header matrix, tiles and manifest alike:
   `http://localhost:5173` allowed, `http://localhost:5219` 200 but NO
   `access-control-allow-origin` (so the browser blocks the read),
   `https://wingover.app` allowed, `tauri://localhost` allowed,
   `capacitor://localhost` 403 at the WAF. The WAF's referer rule is
   prefix-based (any `http://localhost:` port passes it) but CORS is not,
   so a dev server on any port other than 5173 cannot load tiles. Worth
   deciding whether the allowlist should cover `http://localhost:*` the
   way the WAF does.
3. **Coverage.** The app still uses one near-global box (see below).
   Precise coverage in the manifest would let it stop asking for ocean.
   Decided with Alex 2026-07-30: ship USA-only with the mode offered
   everywhere; outside coverage, chart view draws nothing over the
   street base (404s render transparent) and that is accepted. When the
   manifest carries coverage, the app stops requesting outside it and
   stops OFFERING the mode where the viewport has none. No hand-authored
   region boxes client-side; that is this project's recurring defect
   class.
4. `tilePixels` appeared in the old manifest and nothing reads it: the
   MapKit path takes the size off the decoded image and the MapLibre
   source is declared at 256 so the 768px tiles land as retina.

## App work

1. **Manifest resolution.** DONE (`src/ui/shared/map/vfrCharts.ts`). Fetches
   latest.json once per session, caching only success so a launch with no
   signal does not cost charts until relaunch. Implements the
   pre-effective rule, validates the template and zoom range, and shows
   nothing (no banner, one console warning) on any failure. The hardcoded
   URL is gone.
2. **Chart toggle.** DONE. `MapViewKind` gained `"chart"`; it rides the
   street basemap with the sectionals over it. The mode is the existing
   app-wide `mapView` setting, so all four ground maps honor it
   (`useChartOverlay`), and so does the flight surface, which keeps its own
   view state in `liveViewState`. `ViewToggle` takes the cycle it should
   offer as a prop, from `useMapViews(map)`: street always, satellite when
   the backend can show it, sectional once one resolves.
3. **JXL feature-detect.** DONE, inside vfrCharts.ts: a 60-byte 1x1 probe
   in the same ISOBMFF container the tiles ship in. No decoder means no
   mode, no layer and no fetch. Measured through Playwright on
   2026-07-30: WebKit decodes it, Chromium and Firefox reject it, a
   corrupted twin is rejected by all three, and the same three engines
   give the same verdicts on REAL tiles pulled off the host.
4. **Currency line, then the edition chip.** BUILT, then CUT: the line on
   2026-07-30 at Alex's call after seeing it live ("I dont need the
   label"), and the chip that replaced it soon after. `ChartCurrency`, its
   CSS, `chartLabel`, and the manifest `cycle` field all left with them;
   the edition is still selectable by `effective` if a label ever returns.
5. **The pinned template is origin-gated.** `?vfr=<template>` (or a
   `wingover.vfr` localStorage key) may name the chart host or the app's
   own origin, and nothing else — `pinnedTemplate` in vfrCharts.ts, with
   the cases in vfrCharts.test.ts. A template is a URL whose bitmaps the
   map draws AS the sectional and requests tile by tile, so an ungated one
   made any link a way to show a pilot someone else's chart and watch
   where he looked. It is read BEFORE the codec gate, which is also what
   makes chart view reachable in Chromium (see Verification).

## Load-bearing constraints (violating these reopens settled decisions)

- MapKit stays the chart renderer. Its TileOverlay cannot overzoom, so
  the mapkit adapter uses the async image-callback form (fetch + <img>
  decode + canvas), and past z12 it crops+upscales the z12 ancestor
  client-side. Consequence: the tile host must send CORS headers even
  for MapKit — already configured, GET only, but see open question 2.
- MapKit resolves a tile 404 to a transparent tile ONCE and caches it;
  MapLibre doesn't retry 404s. Ocean tiles inside the coverage box 404
  by design (blank-skipped server-side). Don't "fix" this.
- The coverage box (`VFR_COVERAGE` in vfrCharts.ts) is deliberately
  near-global: the product spans the antimeridian (Marianas 145E to
  Virgin Islands 60W, Samoa 14S to Point Barrow 72N), so no single tight
  box exists. Precise coverage arrives via the manifest.
- A sectional is a NAVIGATION chart, so the flight surface offers it too.
  Everything chart-side therefore lives in `src/ui/shared/map/` and both
  buckets use it. This was ground-only for one round, on nothing but an
  agent's assumption; Alex found it missing in flight and it was wrong.
  The cost is real and accepted: chart tiles are ~100KB each and the
  flight surface now fetches them when the pilot picks the mode.

## Verification (this is the part that bites)

- Desktop Chrome and Firefox cannot decode JXL; desktop Safari 17+ and
  iOS can. Playwright's bundled WebKit CAN, which makes a Linux box
  enough to prove decode end to end (fetch → blob → `img.decode()` →
  canvas, the MapKit adapter's exact path). What it is NOT enough for:
  that same WebKit build dies on the WebGL map in headless Linux, so
  full-app chart RENDERING still has to be seen on a phone or in Safari.
- Port 5173 must serve THIS worktree — check the listener's cwd via
  /proc before trusting phone feedback; a stale vite from another
  worktree has burned hours before. If 5173 belongs to someone else, run
  on 5219+ with `--strictPort` and remember open question 2: tiles will
  NOT load cross-origin from that port.
- Stale Safari bundles survive dev-server swaps; retest in a private tab
  before believing a failure.
- First loads on a fresh prefix are cache-cold at the edge; slow first
  pans are normal.
- Chromium reaches chart view through `?vfr=`, which is read before the
  codec gate precisely so the browser-based ring is not stopped by a
  missing decoder. Point it at fixture tiles on the app's own origin (a
  foreign host is refused). That is how `e2e/vfr-chart.spec.ts` proves the
  mode joins the cycle and the raster layer lands.
- Screenshots still earn their keep for the chrome: the one layout bug
  this feature produced — a wide chip stranding the map buttons off the
  right edge — is what a photo catches and a unit test does not.

## Pointers

- Pipeline repo: `~/charts.wingover.app` (local clone), GitHub
  `aeharding/charts.wingover.app`. Its README/scripts are the reference
  for what the tiles contain. Heavy rendering runs on the mac
  (`ssh mac`) in the `ghcr.io/osgeo/gdal:ubuntu-full-latest` container.
- Map abstraction: `src/ui/shared/map/` — the `MapView` interface and its
  two adapters, mapkit and maplibre. CSS-order and launch-URL load-order
  gotchas are real; see the `map-view-abstraction` memory and git history.
- Auto-memory has the full decision trail: `vfr-charts-project`,
  `mapkit-js-gotchas`, `charts-furniture-over-neighbour`,
  `verify-ui-visually`, `stale-5173-dev-server`.
