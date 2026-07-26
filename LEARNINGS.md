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

## NEXT STEPS (actionable, in order)

1. **Reproduce the leading hypothesis in the simulator, hands-free.** Add a
   temporary boot-time harness to a throwaway branch that, in the sim,
   builds a MapKit map and cycles: `impl.setPadding(top 50/0,
   {updateVisibleMapRect:false})` + container height 714↔748 (the tab-bar
   delta) on successive frames, reading `map.center` after each cycle.
   Paint the verdict as a full-screen colour (green = survived, red =
   POISONED) so `xcrun simctl io <udid> screenshot` reads it with no
   console and no touch. Control arm: the same cycle with
   `updateVisibleMapRect: true`.
2. If that reproduces, the 2×2 confirmation is: (a) freeze the tab-bar
   height so only padding changes, (b) freeze the insets so only the
   container resizes. Neither alone should poison.
3. If it does NOT reproduce, add Reachability itself: check whether the
   Simulator's Device menu exposes it (AppleScript can now enumerate and
   click menus), and drive the app-switcher gestures via springboard in
   XCUITest.
4. Fix the diag probe key (per-map, unregistered in `destroy()`) before
   trusting any further `__wingoverDiag()` output.
