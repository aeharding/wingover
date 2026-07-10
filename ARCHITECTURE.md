# Wingover — Runtime Architecture

Elaborates STEERING.md's Architecture and Reliability Doctrine sections.
Written 2026-07-10 while designing waypoint announcements (M4b), the app's
first _real-time side effect_ — but the principles here govern every future
feature (vario beeps, airspace alerts, altitude callouts).

## The classification that drives everything

Every behavior falls into one of three classes, and **the class — not
convenience — decides which layer owns it**:

| Class                     | Definition                                                          | Examples                                                        | Owner                           |
| ------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------- |
| **Derived state**         | Pure function of fix timestamps; replay reconstructs it identically | takeoff/landing detection, flight of record, stats, all visuals | **JS engine**                   |
| **Real-time side effect** | Only meaningful at the moment it happens; replay cannot redo it     | "Waypoint reached" speech, vario beeps, airspace warnings       | **whoever is guaranteed awake** |
| **Platform capability**   | Requires an OS API                                                  | GPS/baro capture, permissions, TTS voice output                 | **native shims**                |

"Whoever is guaranteed awake" differs by platform, and that asymmetry is
the whole design:

- **Native app**: the webview may be suspended (backgrounded) or dead
  (jetsam), but the app process survives under background-location. The
  **Rust core** is the awake party.
- **PWA**: there is no supported background recording (a hidden tab loses
  its geolocation watch — this is precisely why the native apps exist).
  Foreground is the only supported state, so **JS is always awake when it
  matters** and can own side effects directly.

## Balancing the considerations

1. **"JS handles as much as practicable"** — satisfied by the class table:
   everything replayable stays in JS. The engine, WAL, detection,
   finalization, storage, and every pixel remain exactly where they are.
   Rust gets only what _must_ act while JS may be suspended. Nothing moves
   to Rust for performance, taste, or symmetry.
2. **"Rust is the natural home for reusable native-necessary logic"** —
   yes, with a sharpened definition of _necessary_: real-time side-effect
   decisions plus the durable fix core (below). Swift/Kotlin are
   forbidden from containing decisions; they sense and actuate.
3. **"Foreground PWA operates the same way"** — achieved by seams, not by
   sharing a runtime. The same interface, two providers (native-backed and
   web-backed), selected the same way `PositionSource` already is.
4. **"Consider the existing abstractions"** — the design deliberately rhymes
   with `engine/`: every seam below follows the `PositionSource` pattern
   (one interface, a web implementation, a native implementation, mock
   where useful, selected in one place by platform detection).

## The three layers

### 1. Sensor/actuator layer — Swift, Kotlin (per-platform, dumb)

Four primitives, no business logic, no storage:

- `capture` — CoreLocation / FusedLocation → in-memory buffer of raw fixes
- `drain()` — return-and-clear the buffer (called by Rust)
- `permissions` — check/request
- `speak(text)` — AVSpeechSynthesizer / TextToSpeech, audio session
  configured to duck the pilot's music

Everything currently in the Swift plugin beyond these (session file, JSONL,
cursors, torn-tail handling) migrates down into Rust so Kotlin never has to
re-implement it.

### 2. Real-time core — Rust core (shared, alive in background)

- **Ingest**: a task polls `drain()` at 1 Hz via `run_mobile_plugin`
  (supported API; ≤1 s latency is invisible at 1 Hz GPS; a hard kill loses
  ≤1 s of in-memory fixes — within the accepted torn-tail class).
  _Upgrade path if a future feature needs sub-second reaction: direct
  `extern "C"` push from the sensor thread. Documented, not built._
- **Durable session log**: the append-only fix log and session lifecycle,
  owned here, `cargo test`-able on Linux CI (today this logic is Swift and
  only testable in a Mac simulator — moving it is a large test-rigor win).
- **Serving**: `fixes_since(cursor)` as a plain Tauri command. The JS
  engine's `nativeSource` keeps its exact contract; multiple consumers,
  each with its own cursor, are inherent to the design.
- **Announcer**: an in-process consumer evaluating waypoint geofences on
  ingest (event-driven, no polling) and calling `speak()`. Holds re-arm
  hysteresis (must exit radius before re-announcing). Waypoint config is
  pushed from JS on every change and persisted beside the session so a
  webview death cannot silence the callouts.
- Announcements are deliberately **not** journaled: if the process dies,
  the callout is simply missed. Fire-and-forget is the correct durability
  class for audio.

### 3. Flight-of-record layer — JS (unchanged)

`RecordingEngine`, IndexedDB WAL, detection, lifecycle
(`recording → landed → ended`), replay, storage, UI. Background parity via
burst replay, per STEERING.md.

## The core seam (the web reimplements the plugin surface)

The engine sees the same surface on every platform — a single injected
`CoreClient { source, setWaypoints }` (`nativeCore` /
`webCore`) — and runs ONE code path: establish the watch,
push `setWaypoints`. All lifecycle logic rides the
watch, exactly as it does natively:

- **Native**: `start_watch` starts capture AND the Rust core (detection
  reset on a fresh session); `stop_watch` stops capture and clears the
  session + waypoint config; `set_waypoints` is config-only; the Rust
  ingest thread announces and speaks.
- **Web**: `engine/core.ts` is core.rs's TS twin — the same surface,
  function for function (`start` / `stop` / `setWaypoints` / `ingest`),
  carried by the same watch (`webCore` wraps the browser
  source: watch start → `core.start`, teardown → `core.stop`, each
  position → `ingest` → speak). A change to the web lifecycle that has no
  named Rust counterpart is a smell by construction.
- The engine pushes config in exactly two places on every platform:
  establishing the watch (session start AND post-reload rehydration) and
  `addWaypoints`. It never runs announce lifecycle logic itself.
- The simulator is just another `PositionSource` (`simulatorSource.ts`),
  wrapped by the same web core: mock and real GPS share the ENTIRE engine —
  WAL, replay, and every status derivation. Compressed delivery is simply a
  continuous burst replay, which the fix-time doctrine already handles.
- **Audio has a single authority** — Rust speaks on native, the web core
  speaks on the PWA; never both.
- **Waypoint config is flight-scoped.** Starting a flight copies the plan's
  pins into the session (`engine/session.ts` → engine start options → WAL);
  the plan is never read mid-flight, and additions during a flight join that
  flight only (`engine.addWaypoints`). Detection state resets per flight in
  both languages: `core.start` on both sides. On `stop_watch` the core
  (both languages) clears its waypoint config
  (`waypoints.json` deleted) along with the session log — a process death
  MID-flight still rehydrates both, but nothing survives a clean stop.

### The duplication question, answered honestly

Visual "waypoint reached" state must derive in JS anyway (it is derived
state — replayable, shown on the map/tiles). So the TS geofence math exists
regardless, and the Rust announcer re-implements it for audio. That is two
implementations of one small pure function — accepted for v1, guarded by
**shared golden test vectors**: one JSON fixture of (fix stream, waypoint
set) → expected announcement sequence, executed by both the vitest and
cargo suites. Divergence fails CI in both languages.

_Upgrade path_: if real-time logic grows real mass (airspace polygon math
is the trigger), promote the decision core to a Rust crate compiled both
natively and to WASM for the web annunciator — write-once restored at the
cost of a wasm toolchain. Not before then; ~100 lines of haversine does not
justify a build pipeline. (Considered and rejected: embedding a JS runtime
— JavaScriptCore/QuickJS — in the native layer to run the TS logic in
background. Adds a runtime, a debugging surface, and an Android dependency
to avoid duplicating arithmetic.)

## What runs where — the matrix

| Concern                     | PWA (foreground)         | Native foreground   | Native background        |
| --------------------------- | ------------------------ | ------------------- | ------------------------ |
| Fix capture                 | navigator.geolocation→JS | sensors→Rust        | sensors→Rust             |
| Durable in-flight fix store | JS WAL (IndexedDB)       | Rust log + JS WAL   | Rust log (JS catches up) |
| Detection/lifecycle/record  | JS                       | JS                  | JS, on replay            |
| Visuals                     | JS                       | JS                  | — (rehydrated later)     |
| Waypoint audio              | JS (Web Speech)          | Rust (`speak` shim) | Rust (`speak` shim)      |

## Open questions

1. iOS background speech: `.playback` + `.duckOthers` session, possibly
   `audio` in `UIBackgroundModes` — proven pattern in nav/fitness apps but
   Apple's rules are empirical. **Device drill before building on it.**
2. `run_mobile_plugin` from a long-lived Rust task is a less-trodden Tauri
   path — spike it on the Mac before committing the M4b schedule.
3. ~~Announcer scope~~ **Resolved at implementation**: session-scoped
   (arming through finalization) on both platforms — consistency across
   the seam beats the recording-only nicety, and the arms-silently-inside
   rule already covers the launch-waypoint case.
4. Baro (CMAltimeter) joins through the same drain with added fix fields —
   define the fix schema versioning when it lands.
5. Migration sequencing: the Rust core replaces device-drilled Swift
   code — land it **with** M4b, not before the first real flight.

## Migration status (implemented 2026-07-10, pending Mac verification)

1. ✅ Rust: `store.rs` (append-only log, hydration, ordering guard),
   `core.rs` (lifecycle, persist-then-announce, waypoint persistence),
   `announcer.rs` (golden vectors) — 9 cargo tests on Linux CI.
2. ✅ Swift: dieted to capture/drain/permissions/speak (~compiles on Mac
   only — unverified here).
3. ✅ JS: `nativeSource` wire contract unchanged (commands now answered by
   Rust); web core twin of core.rs (`src/engine/core.ts`);
   `src/flight/waypoints.ts` twin passing the same golden vectors; pins
   double as waypoints, live-synced from PlanPage, session-scoped from
   FlyPage.
4. ⏳ Mac session: compile Swift, re-run sim drills (webview kill,
   relaunch — the Rust log replaces the Swift session file), and the two
   audio device drills (background speech, music ducking).
5. Note: JS's engine still keeps its own IndexedDB WAL — two durable
   copies during a flight (Rust log = native truth, JS WAL = replay
   cache). Redundant but harmless; consolidation is a possible later
   simplification once the Rust core has device mileage.
