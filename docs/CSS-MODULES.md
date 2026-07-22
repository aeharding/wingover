# CSS Modules — scope decision

**TL;DR** CSS Modules is wired up and used for new isolated leaf components
(see `NativeIcon`). A *broad* migration of the existing CSS is **not** done on
purpose — the audit below shows it would add churn (mixed `className` soup,
split files) for negligible benefit in this cascade-based, Ionic-integrated
app. Use modules for genuinely-isolated new components; leave the global
cascade (theme, shell, Ionic overrides, the map/replay contracts) as plain CSS.

## The toolchain works
Vite scopes `*.module.css` out of the box — `.native-icon` →
`_nativeIcon_<hash>` in the prod bundle; the default `import styles from
"./x.module.css"` typing (`{ readonly [k: string]: string }`) compiles under
tsc. No extra deps. (Per-class type-safety / dead-class detection would need a
`.d.ts` codegen; not added, since the modularizable surface is tiny.)

## Why not a broad migration (audit)
A per-file class-coupling audit (each CSS class checked for: e2e/native
test-locator use, JS creation via `className`/`classList`/`innerHTML`,
cross-file references, and global `ion-*`/`:root`/element selectors):

- **Genuinely global (keep as plain CSS):** `theme.css`, `desktop.css`,
  `FlyPage.css` — 10-17 global selectors each (Ionic component overrides, the
  `--ion-*` / `--ion-safe-area-*` token layer, the desktop shell). Modules
  can't scope `:root` / `ion-item` / element selectors; these are correctly
  document-scope.
- **Contract / shared classes:** the map (`.map-container`, `.map-overlay`,
  `.map-cluster`, `.map-cell-*`, `.map-button`) and replay (`.replay-dock`,
  `.replay-readouts`, `.barogram`) classes are shared ACROSS components and, in
  the map's case, created in JS by the adapters and read by MapKit/MapLibre.
  Scoping them would mean threading a `styles` object through the backend
  adapters and every host — high churn, and they'd have to stay effectively
  global anyway.
- **Everything else is MIXED:** almost every component tangles a few of its own
  leaf classes with (a) shared classes, (b) dynamic modifier classes
  (`barogram-mark ${kind}`, `barogram-overview zoomed`), (c) JS-created classes,
  and (d) e2e class-locators. Modularizing the clean subset means a component
  renders `className={`replay-dock ${styles.clipTransport}`}` — module + literal
  soup — for classes that are already uniquely named (no collision the modules
  would prevent).
- **Cleanly modularizable:** only `NativeIcon` (done). `BigConfirm` and a
  handful of others become *eligible* once their one e2e class-locator is
  decoupled — but the intrinsic value (scoping ~6 unique classes) is low.

**The real win adjacent to this** is decoupling the e2e suite from CSS-class
locators (`page.locator(".flight-row")` → semantic `getByRole`/`getByText` or
`data-testid`). That improves test resilience and a11y regardless of modules,
and is where the effort is better spent (tracked separately).

## Recommendation
1. New, genuinely-isolated leaf components → `*.module.css` (pattern:
   `NativeIcon`).
2. Existing global/contract/shell CSS → stays plain CSS.
3. Don't force-migrate MIXED components; the mixed-className result is worse
   than the well-named global classes it replaces.
