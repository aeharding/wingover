# iOS bring-up runbook (Mac session)

Everything software-side is prepped on `main`. This session's goal: the app
running on an iPhone, recording through CoreLocation, surviving the M0 kill
drills.

## Already done (Linux side)

- `tauri-plugin-geolocation` registered on mobile builds (`src-tauri/src/lib.rs`),
  capabilities granted (`src-tauri/capabilities/default.json`).
- Engine seam: `GeolocationRecordingEngine` takes a `PositionSource`;
  `tauriSource.ts` adapts the plugin (permissions flow + mapping, unit-tested).
  Engine selection auto-detects Tauri (`__TAURI_INTERNALS__`) — no flags needed.
- `bundle.iOS.minimumSystemVersion: "16.0"` (open question #7 — bump if you decide otherwise).
- `src-tauri/Info.ios.plist` holds the required keys (location usage strings +
  `UIBackgroundModes: location`). **`tauri ios init` will NOT merge these** —
  copy them into the generated `src-tauri/gen/apple/*_iOS/Info.plist`.

## Steps

1. Prereqs: Xcode + iOS SDK, `rustup target add aarch64-apple-ios aarch64-apple-ios-sim`.
2. `git pull && pnpm install`
3. `pnpm exec tauri ios init` — generates `src-tauri/gen/apple`. Commit it.
4. Merge `Info.ios.plist` keys into the generated Info.plist (see above). Commit.
5. Open `src-tauri/gen/apple` project in Xcode once: set the signing team
   (same account as Voyager).
6. Simulator first: `pnpm exec tauri ios dev`. In the simulator,
   Features → Location → Freeway Drive gives real moving fixes — the full
   arming → accuracy gate → auto-takeoff flow should run without leaving the desk.
7. Device: `pnpm exec tauri ios dev --host` (the dev server must be reachable
   over LAN; `devUrl` localhost won't resolve from the phone — tauri rewrites
   it with `--host`, verify).

## M0 kill drills (device, before any real flight)

- Arm → walk/drive until recording → screen off 10+ minutes → still recording?
- Recording → swipe-kill the app → reopen → rehydrated mid-flight from the
  IndexedDB WAL (this is the e2e-proven path; verify WKWebView persists it).
- Recording → airplane mode 2 min → off → GPS reacquires, track resumes.

## Known risk: background delivery

`UIBackgroundModes: location` + the usage strings are necessary but likely
not sufficient: CoreLocation also needs
`allowsBackgroundLocationUpdates = true` (and
`pausesLocationUpdatesAutomatically = false`) on the CLLocationManager, and
the plugin may not set them. If screen-off recording stops:
check the plugin's Swift source (in the cargo registry checkout of
`tauri-plugin-geolocation`, `ios/Sources`), and if the flags are missing,
vendor the plugin (path dependency) and patch — that fork is expected
Phase-B work, budgeted in PLAN.

Also true native-WAL hardening (fixes buffered natively so a dead webview
loses nothing) is deliberately NOT in scope for the first device run — JS-side
IndexedDB WAL is the M0 baseline; measure how it behaves first.

## Report back

What compiled first try, what needed patching, whether background delivery
works with the stock plugin, and Freeway Drive + kill drill results — those
answers drive the next PLAN iteration.
