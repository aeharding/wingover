# Screenshots

Deterministic App Store screenshots (and the web/README images that reuse
them), rendered with Playwright + Chromium against the real app. The app is
captured at device points, then composed into an iPhone/iPad frame at exact
store pixels. Real Apple Maps satellite (MapKit JS), real GPX flights replayed
and held mid-flight, real SF Pro.

## Run

```sh
pnpm screenshots
```

That runs, in order:

| step               | output                                              |
| ------------------ | --------------------------------------------------- |
| `fetch-fonts.mjs`  | `assets/sf-pro.css` (SF Pro, downloaded on demand)  |
| `generate.mjs`     | iPhone 6.9" store shots → `fastlane/screenshots/en-US/iphone-*.png` |
| `generate-ipad.mjs`| iPad 13" store shots → `fastlane/screenshots/en-US/ipad-*.png` |
| `web-optimize.mjs` | device-framed WebP for wingover.app → `public/shots/*.webp` |
| `hero.mjs`         | README filmstrip → `design/hero.webp`               |

The framed store PNGs are written straight into fastlane's folder; the
un-framed captures land in `out/raw/` (gitignored) and feed the web + README
images. Commit the results in `fastlane/screenshots/`, `public/shots/`, and
`design/hero.webp`.

A single shot re-renders in place without disturbing its siblings:

```sh
node screenshots/generate.mjs 4-plan
```

## Prerequisites

- **Dev server** — auto-started on `:5173` if not already running.
- **Apple Maps** — `VITE_MAPKIT_TOKEN_LOCALHOST` in `.env` (satellite needs a
  MapKit JS token that authorizes on localhost). MapKit does not initialize in
  Playwright's WebKit, so these render in **Chromium**.
- **Sync shot** — the connected-sync screenshot replicates to the dev CouchDB;
  bring it up first: `docker compose -f dev/couchdb/docker-compose.yml up -d`.

## Upload

`fastlane/screenshots/en-US/` is committed. Pushing a change there to `main`
triggers `.github/workflows/upload-screenshots.yml`, which uploads to App Store
Connect via `fastlane ios screenshots` (a pure API upload, no build).

## Not committed

- `out/` — regenerable intermediates.
- `assets/sf-pro.css` — ~18 MB of Apple's proprietary SF Pro fonts; rebuilt on
  demand by `fetch-fonts.mjs`.
