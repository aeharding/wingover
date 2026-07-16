# Wingover — Steering Document

_A paramotor flight recorder and planner. v0.1 — 2026-07-09. High-level direction only; no implementation detail lives here._

## Vision

Wingover is a free, open source app for paramotor pilots to record their flights and plan new ones. Spiritual successor to PPG Flyer (iOS, long gone from the App Store): simple, focused, built by a pilot for pilots. Your flights are yours — they live on your device, in open formats, forever.

The defining feature is not the map or the stats. It is that **recording never loses a flight**. Everything else is negotiable; this is not.

## Values

These mirror Voyager for Lemmy, by the same author:

- **Open source, AGPL-3.0.** Development in the open, contributions welcome.
- **Privacy-first, no backend by default.** No telemetry, no analytics, no crash reporters. Out of the box there is no account and no server: data stays on-device and the only network traffic is map tile fetches, with the tile endpoint user-visible and eventually user-configurable. Sync is the sole exception and is strictly opt-in — off until a pilot turns it on, and then only to the server they chose. The app is whole without it; nothing degrades if it is never enabled.
- **Local-first, data ownership.** Open export formats (GPX; IGC candidate). An uninstall or a dead phone should never be the only copy — export/import is core, not an afterthought.
- **Native feel.** Ionic-polished UI that respects platform conventions, matching the bar Voyager sets. Color is authored in `display-p3` — every target device is wide-gamut, so it is the baseline, and sRGB fallbacks are never added.
- **Reliability over features.** A smaller app that never drops a track beats a bigger one that sometimes does.

## Scope

### v1 (mobile only: iOS first, Android later)

1. **Flight recording** — one-tap start; survives backgrounding, webview death, memory pressure, and app relaunch (see Reliability Doctrine). GPS track at ~1 Hz with speed, GPS altitude, and barometric altitude.
2. **In-flight instruments** — live screen while flying: groundspeed, altitude, baro climb rate, heading, flight timer, distance from launch. Screen-off recording fully supported.
3. **Logbook** — chronological flight list; per-flight stats (duration, distance, max/avg speed, max altitude, launch/land points); cumulative totals (airtime, flight count).
4. **Flight replay & stats** — play a flight back on the map with synchronized altitude/speed graphs.
5. **Planning** — a map where the pilot drops and manages pins (LZs, fuel stops, hazards, launch sites) with names and notes. Deliberately simple; not a route engine.
6. **Import/export** — GPX export and import at minimum; share sheet integration.

### Explicit non-goals (v1)

- No social/live-tracking features. No account is required to record, plan or export — ever. (Opt-in sync now exists; see Data & sync. It is a feature you switch on, not a thing the app needs.)
- No offline map region downloads (rely on tile caching; revisit in v2 — pilots fly from remote fields, so this is a strong v2 candidate, not a rejected idea).
- No airspace overlays (large data + rendering scope; revisit later).
- No native desktop app — ever, as currently envisioned. Native wrappers exist solely for recording reliability on mobile; the desktop/computer story is the **PWA** (same web app, installable, syncing via CouchDB once sync exists).
- No route optimization, weather briefing, or e-navigation claims. This is a logger and a pinboard, not a certified nav tool.

### Ideas parked for later

Offline map regions, airspace (openAIP), engine hours / maintenance log (PPG pilots track two-stroke maintenance religiously — natural fit, cheap to add once the logbook exists), IGC export, live wind estimation from track drift. (Opt-in CouchDB sync/backup — self-hosted or paid hosted — has since shipped; see Data & sync.)

## Architecture

Three layers with a hard rule about who owns what:

1. **UI layer — Ionic React + TypeScript in the Tauri webview.** Treated as _disposable_: it can be killed, suspended, or reloaded at any moment and nothing of record may live only here. On load or foreground it rehydrates from the layers below.
2. **Tauri core — Rust.** Plumbing, commands, filesystem access, shared logic that doesn't need to survive backgrounding.
3. **Native recording engine — a custom Tauri mobile plugin (Swift first; Kotlin when Android lands).** Owns the GPS/baro pipeline and the active flight, end to end. iOS: CoreLocation with background location updates (When-In-Use permission is sufficient — never ask for Always) + CMAltimeter for baro. Android (later): foreground location service, designed provider-agnostic so a Google-free build (F-Droid) needs no rework.

_Runtime elaboration — which layer owns which class of behavior, the
realtime core, and the annunciator seams — lives in
[ARCHITECTURE.md](ARCHITECTURE.md)._

### Source of truth

| Data                        | Lives in                                           | Why                                              |
| --------------------------- | -------------------------------------------------- | ------------------------------------------------ |
| Active flight (in progress) | Native append-only write-ahead log (app container) | Must survive webview death and app relaunch      |
| Finished flights (logbook)  | PouchDB (on IndexedDB)                             | Webview-convenient; only written at finalization |
| Planning pins               | PouchDB `wingover` (synced)                        | Low stakes, UI-owned                             |
| Settings                    | PouchDB `wingover-local` (never synced)            | Device preferences, not possessions              |
| Sync credential             | iOS Keychain; IndexedDB elsewhere                  | Derived, un-resettable, grants remote access     |

The native WAL is the _only_ holder of in-flight data. On stop, the flight is finalized into IndexedDB and the WAL is cleared. IndexedDB is durable in an app-embedded WKWebView (app container storage, not subject to Safari's web-data eviction), but export remains the real backup story.

### Data & sync

The store is **PouchDB** (Apache PouchDB, incubating — the same stewardship ecosystem as CouchDB itself), adopted from day one so sync was native rather than a migration. Flight metadata is a document; the immutable track is a gzipped attachment on a **separate** `track:` document, because PouchDB re-sends a document's attachments on every revision of that document when pushing — with the track attached to the flight, renaming one re-uploaded the whole track. Split, a rename replicates a few hundred bytes and the track is sent exactly once. Deletes are native tombstones; auto-compaction is on from birth so revision bodies never accumulate. Flights are effectively immutable after landing, so the real conflict surface is tiny.

Opt-in sync is plain **CouchDB replication**: users self-host CouchDB for free, or use an optional paid hosted instance — the honest FOSS monetization shape. Proprietary sync substrates (iCloud, Dexie Cloud) are rejected on principle.

The client speaks basic auth to a stock CouchDB and knows how to do nothing else. Self-host is a URL and credentials a pilot types; the hosted instance hands back the same triple after a subscription. That is one code path, not two that happen to agree — which is what keeps "run your own CouchDB" from quietly becoming theatre.

**Paying buys writes, not reads.** A lapsed subscription is read-only, never locked out: every flight stays readable, pullable to a new phone, and exportable. Sync is also paused for the duration of a flight — recording outranks it, always.

The billing service is closed-source and lives outside this repo; it is a payment gate for the hosted instance and has no part in self-hosting, which needs only CouchDB itself.

_The user-facing shape of all this — the Subscription / Log In split, settings rows, onboarding flows, and copy rules — lives in [SYNC-UX.md](SYNC-UX.md)._

## Reliability Doctrine

The invariants, in priority order:

1. A started recording continues until the pilot stops it or the hardware makes continuing impossible.
2. No recoverable failure loses more than a few seconds of track.
3. After _any_ interruption, foregrounding the app shows the recording in progress, exactly where it left off, with zero pilot action.

| Failure                           | Behavior                                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| App backgrounded / screen off     | Native engine records normally; UI is irrelevant                                                                                                  |
| Webview killed by memory pressure | Recording unaffected; webview reloads and rehydrates from native state                                                                            |
| App process killed by OS          | iOS keeps location apps alive aggressively; if it happens anyway, next launch finds an unfinalized WAL → offers/auto-resumes recovery             |
| Pilot force-quits mid-flight      | iOS stops location for force-quit apps (platform limit shared by every flight app); WAL recovery on next launch, nothing already recorded is lost |
| Phone reboot / battery death      | WAL recovery on next launch                                                                                                                       |
| Storage write failure             | Surface loudly; never fail silently                                                                                                               |

These invariants double as the primary test suite: the "kill drills" (background 30+ min, force webview termination, force app termination, relaunch mid-recording) are automated in CI against simulators and re-run on physical hardware before each release. See Testing Strategy.

### Background parity: the engine replays, the UI derives

Nearly as load-bearing as webview disposability, and its logical completion:
**the app behaves identically foregrounded and backgrounded.** Backgrounding
is not a special mode — from the engine's perspective it is merely fixes
arriving in a burst instead of one per second.

- The native layer is the recorder of truth. It buffers every fix durably,
  regardless of what the JS layer is doing.
- On foreground (or reload, or relaunch), the JS engine pulls everything it
  missed and processes it through the _same_ code path as live delivery.
  There is no separate recovery path to rot.
- **Every flight-semantic decision — arming, takeoff, landing, flight
  finalization — is a pure function of fix timestamps, never of wall-clock
  time.** A takeoff that happened while the phone was asleep is detected and
  backdated on replay exactly as it would have been live. A landing that
  happened forty minutes ago finalizes the flight retroactively at the
  touchdown fix, discarding the stationary tail, the moment the backlog is
  replayed.
- The UI holds no truth. React state derives from engine snapshots and
  events, and must tolerate an hour of history arriving in one second
  (the live map jumps rather than animating through a large backlog).
- Business wiring lives in headless JS modules, never in components. React
  renders derived state and forwards user intent; anything that must happen
  regardless of which page is mounted — the plan being copied into a
  starting flight, the annunciator following the session lifecycle — is
  wired engine-side (`src/engine/session.ts`; the web core
  `src/engine/core.ts` is a TS twin of the plugin's core.rs, driven by
  the same watch lifecycle). The boundary is a directory boundary — React
  exists only under `src/ui/` — and it is mechanical: eslint bans
  React/Ionic imports from `src/engine`, `src/flight`, and `src/storage`.
- **A flight owns its waypoints.** The Plan tab is a reusable template for
  the NEXT flight; starting a flight copies the plan's pins into the
  session. Mid-flight additions join that flight only. An active flight
  never re-reads the plan.

Test consequence: burst-replay IS the backgrounding drill. Emitting a full
flight — takeoff, cruise, landing, stationary tail — as one rapid stream of
correctly-timestamped fixes must produce byte-identical results to flying it
in real time. This is automated in e2e; hardware drills only verify that the
OS actually delivers fixes while asleep.

## Testing Strategy

Real test flights exist but are precious — the maintainer can fly, but not iterate by flying. A test flight is a _validation event_, never a debugging session: by the time the app leaves the ground, automation must have already found the bugs. **The first flight should simply work.** Testing is therefore automated, sophisticated, and part of the product — every layer is designed for simulation-first testing, and a feature isn't done until its tests drive it end to end.

- **Simulated flights are the universal test input.** A fixture library of flights — synthetic tracks (climbs, spirals, low passes, touch-and-goes, GPS dropouts) plus real-world PPG GPX tracks — feeds every ring: the mocked seam in the browser, scripted location injection in the iOS Simulator (GPX playback / `simctl`), and emulator geo streaming on Android later. Playback is time-compressed so a two-hour flight tests in seconds.
- **Browser-ring e2e (Playwright).** Full user journeys against the real UI with the mocked seam: record → interrupt → rehydrate → stop → logbook → replay → export. Runs on Linux on every commit; this is where the bulk of e2e coverage lives.
- **Simulator-ring e2e.** The real app and real native plugin against simulated location, with the kill drills scripted: background the app, kill the webview content process, kill the app, relaunch — assert recording continues or recovers with nothing lost beyond the flush window. Runs on the Mac sparingly at first, then in CI on macOS runners as part of the Voyager-style beta pipeline.
- **Native engine tests.** The location source is abstracted so the Swift (later Kotlin) engine is unit-tested with injected fixes: WAL write/flush ordering, recovery from truncated and corrupt WALs, finalization, baro handling.
- **Golden-track tests.** Known input flight → asserted stats (duration, distance, max altitude/speed, launch/land detection) and stable export output. Export is deliberately lossy and that is the trade: GPX 1.1 carries lat/lon/ele/time and dropped `<speed>`/`<course>` from 1.0, and has no home at all for climb rate or accuracy-in-meters (`hdop`/`vdop` are dilution-of-precision, a different quantity). So a round-trip returns a track that is interoperable, not identical — import reconstructs speed, course and climb rate from geometry, and the accuracies are gone. Interop is worth that at the export boundary; it is why the stored track stays JSON, where the record is complete.
- **Soak test.** A long simulated flight with randomized interruption events injected throughout, asserting zero data loss — run scheduled in CI, not on every commit.
- **Honest gaps, ground-truthed before flying.** Simulators can't reproduce real jetsam decisions, GPS chip behavior, or battery/thermal reality. That gap closes on the ground first: unattended real-device drills — phone recording in a pocket during a long drive or walk, screen off, hours at a stretch — exercise the identical pipeline; a flight is the same data, just higher. TestFlight beta pilots widen coverage before 1.0.

**Flight-ready** means: the full automated matrix is green, and multiple unattended multi-hour ground recordings on physical hardware have completed with zero loss. Only then does a real flight happen — as sign-off, with the expectation it works the first time.

## UI Principles

Extremely simple, barebones, straightforward — in the spirit of PPG Flyer. The UI's job is to stay out of the way of someone standing in a field wearing gloves. (Original PPG Flyer App Store screenshots are saved in `reference/ppg-flyer/` for design reference — copyrighted material, keep out of the public repo.)

- **Few screens, no fluff.** Record, logbook, plan, settings. Every screen and control must justify its existence; when in doubt, leave it out.
- **Plain CSS.** Ionic provides structure, navigation, and platform idiom; styling on top is plain `.css` files. No CSS-in-JS, no Tailwind, no preprocessors, no design system beyond a handful of variables. It doesn't need anything crazy.
- **Gloves-first.** Oversized touch targets well beyond platform minimums, especially for anything used pre-flight or in-flight. No fiddly gestures, long-presses, or small toggles on the critical path. Stopping a recording is guarded against accidental taps (deliberate action, not a stray thumb).
- **Sunlight-readable.** High contrast, large numerals on the instrument screen, dark mode. Designed for a phone strapped to a leg or arm in full daylight.
- **Simple and elegant** beats dense and configurable. Sensible defaults over settings.

## Development Model

The developer machine is Linux; the first shipping target is iOS. This forces a discipline that is good for the project anyway: **the device is for verifying the native layer, not for iterating on the app.**

- **Browser-first.** The UI and all app logic run in a plain Vite dev server. The native recording engine sits behind a small TypeScript seam with a mock implementation that plays back simulated/recorded flights — instruments, replay, logbook, and planning are all fully developable without any device.
- **Tauri desktop on Linux as second ring.** A local desktop build (WebKitGTK — usefully close to WKWebView's engine family) exercises real Tauri IPC and Rust core with the mocked native seam. Dev/test vehicle only — not a shipping target; desktop users get the PWA.
- **Device as third ring.** Real iOS builds only when the native plugin or platform integration changes. A physical Mac is available for test builds but is used _extremely lightly_; the steady state is Voyager-style CI (macOS runners building betas → TestFlight). The architecture's job is to make Mac-requiring builds rare.
- Android, though shipping later, builds natively on Linux and can serve as an early physical-device testbed for the recording doctrine if useful.

## Platform & Distribution

- **Identity**: domain `wingover.app`; app identifier `app.wingover.wingover`.
- **iOS first**: App Store, TestFlight for betas. Reasonable minimum iOS version chosen at implementation time.
- **Android later**: Play Store, F-Droid, and direct APK. The F-Droid target is honored from the start by keeping the design free of Google Play Services dependencies.
- **PWA eventually**: the same web app, statically hosted (wingover.app), installable on desktop and anywhere else — the only "desktop app" there will be. Recording in the PWA is best-effort at most; native mobile wrappers exist precisely because reliable recording needs them.
- Native mobile apps only for v1.

## Maps

**MapLibre GL JS** everywhere (decided 2026-07-09): vector-first rendering, GPU-drawn, labels are client-side data — they stay upright and re-place when the map rotates (track-up flight mode), never baked into tiles. Markers (pins, launch, aircraft) are DOM/SVG, styled with our plain CSS.

Two toggleable views, PPG Flyer-style:

- **Street**: OpenFreeMap vector tiles — keyless, free, OSM-based.
- **Satellite**: MapTiler raster imagery + OpenFreeMap label/road layers composited on top (hybrid — labels stay vector and upright over photography).

No backend, so the MapTiler key is a build-time constant (origin-restricted, client-visible by design — standard for maps) with a settings override; builds without a key simply hide the satellite toggle. All tile/style URLs are user-overridable config, never hardcoded — self-hosters can point at their own tiles, and the parked offline feature (PMTiles region downloads) slots into the same seam. Proper attribution always visible. Apple MapKit was considered and rejected: proprietary renderer lock-in, no offline path, privacy cost.

## Privacy Posture

- Location data never leaves the device unless the pilot turns sync on, and then only to the server they chose — wingover.app, or their own CouchDB. There is no third party in either path, and no copy anywhere the pilot did not ask for.
- **Sync can remove a flight from a device.** Replication carries deletes: delete a flight on one device and it goes on the others. That is what sync means and it is correct CouchDB behaviour, but it is the first mechanism in the app by which a flight can vanish from a device the pilot never touched — worth stating plainly against "recording never loses a flight", which is about capture, not about a pilot's own later decision to delete.
- No telemetry of any kind, including "anonymous" analytics and crash reporting.
- Minimal permissions: When-In-Use location (not Always), motion/baro. Each permission requested in context with an explanation.
- Documented honestly: map tile requests expose the user's IP and rough viewport to the tile provider; this is the app's entire network surface.

## License & Governance

- **AGPL-3.0**, same as Voyager.
- Maintainer-led, contributions via PRs. Issue tracker in the open from day one.

## Milestones

- **M0 — Reliability spike.** Prove the doctrine before building the product: native plugin recording on a real iOS device, WAL + rehydration, all kill drills passing — with the drills automated from day one, since the test harness _is_ part of the spike. _The riskiest assumption gets validated first; if this fails, the architecture changes, not the invariants._
- **M1 — Recording MVP.** Start/stop, logbook list, basic per-flight stats. TestFlight.
- **M2 — Instruments + replay.** In-flight screen; replay with graphs.
- **M3 — Planning + portability.** Pins, GPX export/import, share sheet.
- **M4 — Polish + App Store release.**
- **M5 — Android port.** Kotlin engine implementation, F-Droid pipeline.

## Open Questions

- IGC export in v1 or later; whether any paragliding-ecosystem compat (XContest-style) matters to PPG users.
- Baro/GPS altitude presentation and calibration UX (QNH entry? relative-to-launch?).
- Tile provider choice and cache behavior.
- Simulator-ring e2e driver: XCUITest vs. Appium (webview automation support is the deciding factor).
- Recovery UX: auto-resume an interrupted recording vs. prompt the pilot.
