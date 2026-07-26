# #185 — grey map / black screen: learnings

Working notes for the MapKit corruption bug. Every entry is either a
measured fact or an explicitly-labelled hypothesis. **Do not add to this
file without leaving an actionable next step at the bottom.**

## The bug

On the Plan tab, MapKit's map rect acquires a non-finite origin. The map
greys out permanently. Any later read of `map.center` throws
`TypeError: [MapKit] map rect property origin.x is not a number`, and
because there is no error boundary the throw unmounts React and the whole
screen goes black.

## Deterministic reproduction (device)

1. Plan tab, map rendering.
2. Swipe up to the app switcher.
3. Very long/fast swipe down to trigger iOS **Reachability**.
4. Swipe up to focus the app.
5. Swipe up again to the app switcher.
6. Map is grey. 100% of the time.

Does NOT reproduce on the flight-detail preview or the fullscreen logbook
map.

## Established

- Per-instance: a fresh `mapkit.Map` in the same page is healthy, and
  `location.reload()` recovers.
- The page never dies — app, WebContent, GPU and Networking processes all
  alive during a blackout.
- The thrower is `projectedZoom` (`mapkit/adapter.ts`), whose first
  statement reads `map.center` — the guard for a degenerate projection
  throws in exactly the case it exists for.
- The fatal path is React's layout-effect commit →
  `defaultOnUncaughtError` → root unmounted (`rootChildren: 0` captured).
- MapKit's PUBLIC padding setter corrupts a map on the first pan after a
  foreground; our private `setPadding(p, {updateVisibleMapRect:false})`
  does not. The private write is protecting us, not hurting us.
- Suppressing the rect update drifts the camera ~490 km on a resize.

## Ruled out by measurement

WebContent crash; GPU-layer reclaim; a globally broken MapKit worker;
overlays with bad geometry; falling back to the public padding setter (the
private path verifiably works); our camera writes (prototype trace empty);
our config writes (trace empty); map born at 0×0 (fix deployed and
confirmed live, still reproduces); backgrounding alone; panning alone; a
synchronous `map.center` read inside `region-change-end`.

## Leading hypothesis (NOT yet proven)

**Padding write and container resize in the same frame, with the rect
re-derivation suppressed.**

The Plan map is the only MapKit map whose container HEIGHT is a function
of a safe-area inset:

- `ion-tab-bar` is `box-sizing: content-box` with
  `padding-bottom: var(--ion-safe-area-bottom)`, and `theme.css` pins
  `height: 64px` — so its border-box height is `64 + bottomInset`.
- Plan's map is `flex: 1` in that column, so its height tracks the inset.
- `PlanPage.module.css` forces `--ion-safe-area-bottom: 0` for the map
  subtree, so the inset PROBE never sees the bottom inset.

Padding and size therefore move independently, and `writePaddingWithoutRect`
suppresses the recompute that would reconcile them. Reachability drives
that cycle twice.

Why the other surfaces survive:

| surface | geometry | padding | result |
|---|---|---|---|
| Plan | height tracks bottom inset | top: 50 written | **dies** |
| fullscreen logbook | `position: fixed; inset: 0`, portaled outside the tab column | written | survives |
| detail preview | `46svh`, static unit | `consume-all` → never written | survives |
| Fly | same tab coupling as Plan | real insets | matches the original in-flight sighting |

## Instrumentation warning

`registerDiagProbe("mapkit", …)` uses a FIXED key into a module-scoped map
and never unregisters, so with several tab pages mounted it reports
whichever map was constructed LAST. `snapshot()` uses `document.querySelector`,
i.e. the first matching element. **Readings attributed to "the poisoned
map" may describe a different map.** Fix the probe key before drawing any
further conclusion from `__wingoverDiag()`.

Also: console probes that redefine `mapkit.Map.prototype` accessors perturb
what they measure. Poisonings clustered near those pastes.

## Also wrong, regardless of this bug

- `CompassButton` reads MapKit from React's RENDER phase
  (`useSyncExternalStore` → `map.camera()` → `map.center`). On a poisoned
  map that throws inside render, uncaught. Mounted unconditionally on Plan.
- `atomicPanZoom` does `delete impl._visibleMapRect` — removing a field
  from Apple's object. Prototype accessor traces are blind to it.
- `width()` fabricates `clientWidth || 390` and feeds it to `fitBounds`.
- `fitBounds` can hand MapKit a zero-span region.
- `destroy()` leaks listeners, the glyph set, the diag probe and a timer.
- Nothing reacts to a post-birth 0×0 collapse; `laidOut()` guards
  construction only.

## Tooling that works

- `ssh mac` reaches Xcode 26.6, simulators, and a build checkout at
  `~/wingover-pr153`.
- AppleScript GUI scripting over SSH **now works** (accessibility granted),
  so the Simulator app can be driven by menu and by click.
- `xcrun simctl install/launch/io screenshot` — verified working on
  simulator `87165517-6BAD-4856-966B-398CCF0C5FD2` (iPhone 17 Pro, iOS 26).
- Sim build artifact: `~/wingover-pr153/src-tauri/gen/apple/build/arm64-sim/Wingover.app`
  (`tauri ios build --target aarch64-sim --debug` errors on an archive
  rename but produces the .app).
- `xcrun devicectl device info processes` / `process launch --console` /
  `sendMemoryWarning` / `sysdiagnose` all work against the real device.
- NOT available: Safari Web Inspector headlessly, `ios_webkit_debug_proxy`,
  Homebrew.

## Simulator harness — WORKING, and results

Hands-free loop is built and proven: a boot-time harness (`src/ui/reproHarness.ts`,
branch `repro/sim-padding-resize`) runs experiments with no console, no touch
and no inspector, and paints its verdict so `xcrun simctl io <udid> screenshot`
reads it. Build → install → launch → screenshot all work headlessly over
`ssh mac`. Sim: `87165517-6BAD-4856-966B-398CCF0C5FD2` (iPhone 17 Pro, iOS 26).
Fresh sim app lands in DerivedData
(`.../Build/Products/debug-iphonesimulator/Wingover.app`), NOT in
`gen/apple/build/arm64-sim` — the `tauri ios build` rename error means that
path stays stale.

Measured in the simulator, mapkit 6.0.122:

- **Losing the map's own GL context does NOT poison it.** `contextLost=true`
  and `map.center` still reads fine. So GL context loss is not the NaN.
- **Flooding 24 WebGL contexts does not poison it either** (same result).
- **Padding + resize with the rect refresh suppressed: survived 20 cycles.**
  Its control also survived. That hypothesis is DEAD.

But a context-lost map renders nothing, which IS a grey map. So the likely
shape is two steps: context loss greys it, and something done TO a
context-lost map produces the NaN.

## MapKit facts, from Apple's shipped bundle

- MapKit JS 6 renders in **WebGL** and has **zero** context-loss handling:
  no `webglcontextlost`, no `webglcontextrestored`, no `isContextLost` in any
  of its 39 chunks.
- On `getContext` failure it runs a silent teardown that removes its canvas
  and nulls its context **but leaves `destroyed = false`**.
- The thrown string comes from a generic map-rect validator in
  `mapkit.core.afe1f1.js`; the NaN is produced upstream in `984238`.
- **MapKit JS has no Workers at all** (zero `Worker` tokens, v5 and v6). The
  `this.df[t][v]` blob-worker error is therefore NOT MapKit's — maplibre's
  bundle does use a blob worker. The earlier "MapKit's worker dies" note is
  wrong and must not be built on.
- No suspend/resume API exists. `destroy()` is the only lifecycle method, so
  recovery can only be destroy + recreate.
- The loader does not pin a version (`@apple/mapkit-loader` defaults to "6"),
  so Apple ships new builds under us silently. Pinning works and is verified
  (`6.0.121` and `6.0.122` are genuinely different files), so Apple's builds
  can be bisected.
- Nobody on the public internet has ever reported this exact error string.

## NEXT STEPS (actionable, in order)

1. **Drive a context-lost map** (harness v3, running): pad it, resize it,
   project coordinates through it, gate rotation on it. If any of those
   produces the NaN on a dead context, that is the mechanism, reproduced
   headlessly.
2. **Confirm the grey visually in the sim**: leave a context-lost map on
   screen and screenshot it. If it renders grey, the grey map is reproduced
   deterministically and the first half of the bug is closed.
3. If the sim still will not produce the NaN, escalate the trigger: drive
   Reachability + the app switcher. AppleScript GUI scripting over SSH now
   WORKS (accessibility granted), so the Simulator's menus and window can
   be driven; enumerate the Device menu for a Reachability item, and drive
   springboard gestures from XCUITest for the app switcher.
4. Bisect Apple's MapKit builds (`load({version: "6.0.121"})` etc.) to test
   whether this is a recent Apple regression. Pin the version regardless —
   an unpinned loader means Apple can change flight behaviour with no
   deploy from us.
5. Fix the diag probe key (per-map, unregistered in `destroy()`) before
   trusting any further `__wingoverDiag()` output — with several tab pages
   mounted it currently reports whichever map was constructed LAST.
