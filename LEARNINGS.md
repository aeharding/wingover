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

## ROOT CAUSE (read from Apple's source, and reproduced by running it)

`camera.center.x` becomes NaN. Padding is not involved.

1. The throw comes from a *coercer* whose first line is
   `if (t instanceof H) return t` — a real MapRect is never validated, so the
   value reaching it is the plain object from `Camera.toMapRect()`, i.e. the
   NaN is in `camera.center`.
2. `MapPoint`/`MapRect`/`Coordinate`/`MapSize` all validate NaN in their
   constructors. Exactly two writes bypass that, and both are in
   `Camera.translate()` / `setCameraAnimated`, which build the point with
   `Object.create(MapPoint.prototype)`. `translate()` is fed by
   `_panMapCameraBy` — the pan gesture and its deceleration.
3. The NaN delta comes from `locationInElement()`: `e.x /= t` where `t` is the
   tracked touch count. **Empty list → 0/0 → NaN.** `_updateTargetTouches`
   empties that list AND nulls the `_lastKnownEventLocation` fallback on every
   move.
4. **`touchesCancelled(t) {}` is EMPTY** and the pan recognizer never overrides
   it. `enterCancelledState()` is reachable from exactly one place in the whole
   library: the `enabled` setter. So no MapKit recognizer EVER unwinds on
   `pointercancel`. When iOS steals a touch — Reachability, app switcher,
   Control Center — the recognizer stays armed with an empty touch list, and
   the next stray `pointermove` detonates it.
5. A NaN velocity passes the too-slow filter (`!(NaN < 62500)` is true) and
   never self-terminates (`Math.abs(NaN) <= 10` is false forever) — which is
   why every captured stack ended in `_decelerationEnded`.

`this.df[t][v]` is Syrup's (`mk-csr.js` line 30 col 505, the label-collision
grid), downstream of the NaN. NOT MapKit-core, NOT a cause.

### Repair and prevention, both verified against Apple's real code

- Detect: `try { void map.center } catch { poisoned }`. `zoomLevel` and
  `rotation` stay readable and finite.
- **Repair: `map.center = <Coordinate>`** (or `map.visibleMapRect = <MapRect>`).
  Resizes, padding writes and region sets do NOT repair; the public padding
  setter and region setters THROW because they read the rect.
- **Prevent: on `pointercancel`/`touchcancel`, `map.isScrollEnabled = false;
  map.isScrollEnabled = true`** — MapKit's own internal `interrupt()` idiom and
  the only path that reaches `enterCancelledState()`.

Nothing the app does causes this. `writePaddingWithoutRect` is not implicated,
and the "public padding setter poisons a map" side-finding is explained: it
throws only because the camera was ALREADY NaN.

## Superseded hypothesis (kept so it is not re-tried)

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

1. **Confirm the mechanism in the simulator** (harness experiment H, in
   flight): synthesize `pointerdown` → moves → `pointercancel` → stray
   `pointermove`, then read `map.center`. Verify the repair
   (`map.center = <Coordinate>`) and the guard (`isScrollEnabled`
   false/true) in the same run. Only then write a fix.
2. **The fix, once H confirms** — three separable parts:
   - Guard: on `pointercancel`/`touchcancel`, bounce `isScrollEnabled` so the
     recognizer unwinds. Prevents the poisoning at source.
   - Repair: detect a throwing `map.center` and reassign the last known good
     centre. Heals a map that got poisoned anyway.
   - Containment: no MapKit read may escape into React. `projectedZoom`
     (`mapkit/adapter.ts:238`) reads `map.center` as its first statement, and
     `CompassButton` reads the camera from React's RENDER phase — either
     throws straight into a commit with no boundary.
3. Pin the MapKit version. The loader defaults to "6", so Apple ships new
   builds under us with no deploy; pinning is verified to work and lets their
   builds be bisected.
4. Fix the diag probe key (per-map, unregistered in `destroy()`) before
   trusting any further `__wingoverDiag()` output — with several tab pages
   mounted it currently reports whichever map was constructed LAST.
5. Grey map is a SEPARATE defect, already reproduced in the sim: WebGL
   context loss with no handling in MapKit. Recovery requires destroy +
   recreate; there is no resume API.
