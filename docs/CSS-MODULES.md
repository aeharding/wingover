# CSS Modules — approach

**TL;DR** CSS Modules is the direction for the whole app's component CSS, the
way [Voyager](https://github.com/aeharding/voyager) does it (165 modules, 6
plain files). This PR wires the toolchain and migrates the first leaf
(`NativeIcon`); the rest follows as an architecture pass, not a 1:1 rename.
The only CSS that stays global is the design-token / palette / Ionic-variable
layer (`theme.css` plus a global-overrides entry) — exactly Voyager's handful
of plain files.

## The toolchain works

Vite scopes `*.module.css` with no extra deps: `.native-icon` →
`_nativeIcon_<hash>` in the prod bundle, and the default `import styles`
typing compiles under tsc.

## Two facts that make it work everywhere

An earlier draft of this doc argued against a broad migration on two grounds
that are both wrong. For the record:

1. **Modules only rewrite _class_ selectors.** `ion-header`, element tags,
   `::part()`, and `--ion-*` custom properties pass through untouched — you
   write them straight inside a `.module.css`, scoped under the module's own
   class. Only Ionic _utility classes_ (`.ion-page`, `.ion-hide`) and
   third-party classes (MapKit's `.mk-*`) need `:global(...)`. So an
   Ionic-heavy component is not "unmodularizable"; it just carries a few
   `:global()` escapes, as Voyager's do.
2. **JS-built classes hash fine.** `el.className = styles.waypointPin` — the
   imported `styles` object carries the hashed name at runtime (`NativeIcon`
   already relies on this for its mask class). Map adapters that set classes
   in JS import the module and use `styles.x`; only classes owned by a library
   (MapKit's) stay `:global`.

## Architecture pass, not a rename

A shared class — one CSS file's class used by a different component — is a
smell, not something to preserve behind a shared module. Each is triaged:

- **Relocate** misplaced styles to the component that renders them.
  `FlyPage.css`'s `.idle-*` / `.fly-splash` belong to `FlySplash`;
  `.map-compass*` to the `CompassButton` that draws it; the settings-row tone
  classes to `SettingsPage`.
- **Extract a component** where a shared class is really a missing one:
  `.map-cluster` + `.map-cell-*` is a `<MapCluster>` overlay grid currently
  hand-rolled in three pages.
- **Keep one shared module** only for a feature's genuine shared vocabulary
  (the sync sheet's `.sync-*`), imported by that feature's pieces.
- **Ignore false shares** — a config string `"tile"` that means a map tile,
  not the `.tile` class.

The point is to let the migration _remove_ coupling, not re-encode it in
module syntax.

## Type safety

The pilot uses Vite's built-in module typing. The full migration adopts
`typed-css-modules` (`tcm src`) like Voyager, committing a `*.module.css.d.ts`
next to each module, so `styles.foo` is a checked name and a missed or renamed
class is a tsc error rather than a silent `undefined` className.

## Stays global (the token layer)

`theme.css` and a global-overrides entry hold `:root`, the palette, and the
`--ion-*` / `--ion-safe-area-*` variables — selectors modules can't scope and
shouldn't. This mirrors Voyager's `theme/*.css` + `globalCssOverrides.css`.

## Status

DONE. 33 modules, one plain file: `theme.css` (the `:root` token/palette/
Ionic-variable layer — the one thing modules can't and shouldn't scope).
Conventions the migration settled on:

- **Short names**: scoping is the module's job, so it's `styles.sun`,
  `styles.row`, `styles.button` — never `styles.idleSun` or
  `styles.flightRowId`.
- **Cross-module selectors import the class**: `@value button from
"./map.module.css";` then `.controls :global(.button)` — the compiled
  selector carries the _other module's_ hash. Never hard-code a global
  string for a class a module owns.
- **`:global()` only for classes we don't own**: the palette class
  (`.ion-palette-dark`), Ionic-stamped classes (`.list-inset`), library
  DOM (`.maplibregl-*`, `.mk-*`), and app-level body state
  (`body.flight-map-full`).
- **Variant props over reach-ins**: a host never styles another
  component's internals by descendant selector; the component exposes a
  variant (`<ReplayDock seat>`) or takes a placement `className`
  (`<LiveTrackMap className={styles.liveMap}>`).
- **Never rely on same-element cross-module ties.** Two single classes
  from different modules on one element tie on specificity, and the
  winner is bundle emission order — which DIFFERS between dev (import
  order) and prod (chunk concatenation). Adversarial review caught three
  shipped-neutral-in-prod regressions from exactly this (the red Stop
  button, the seat overlay anchor, the speed button size). When a local
  class overrides a contract class's property on the same element, scope
  it under a local ancestor (`.controls .stop`, `.map .overlay`) so
  descendant specificity decides, order-independently. Corollary: visual
  verification of cascade behavior must run against the PROD bundle
  (`vite build` + preview or a computed-style harness), never the dev
  server.
- **Types**: `pnpm generate:csstypes` (typed-css-modules) writes a
  committed `*.module.css.d.ts` per module; a missed or renamed class is
  a tsc error.
- **Tests/harness**: e2e and `e2e/inset-probe.mjs` locate by
  `data-testid`/roles only — hashed class names never appear in tests.
