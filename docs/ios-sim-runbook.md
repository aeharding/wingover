# iOS simulator CI: flake + speed runbook

A handoff for a Claude/Fable session running on macOS with Xcode. Goal:
cut the sim job's ~20% flake rate and its 6-minute test phase. Written
from CI-log analysis (last 40 runs); local reproduction needs real
macOS, which the authoring session did not have.

## The data (last 40 runs of ci.yml)

- Job medians: build sim app 247s, boot+install 166s, XCUITests 366s.
- Genuine sim flakes: 7 of 35 runs (two more "failures" were a real tsc
  break, not flakes). All 7 are one family:
  - WaypointUITests testWaypointAnnouncementSpokenWhileBackgrounded: 3
  - RecordingUITests testRecordingSurvivesBackgrounding: 2 (once paired
    with the waypoint test in the same run)
  - KeyboardUITests testKeyboardSuite: 3 (ONE was "Timed out attempting
    to launch app" on the suite's first launch; the others assert)
- KeyboardUITests runs first (alphabetical) and eats the cold start.

## Reproduce locally

```sh
pnpm install && pnpm exec tauri ios build --target aarch64-sim --debug
# boot a simulator, note UDID (xcrun simctl list devices booted)
./ios-tests/run.sh <UDID>   # grants location + starts the host-side
                            # location playback (see comments in run.sh)
xcodebuild test -project ios-tests/WingoverUITests.xcodeproj \
  -scheme WingoverUITests -destination "id=<UDID>"
```

Loop a single flaky test:
`xcodebuild test ... -only-testing:WingoverUITests/WaypointUITests` in a
`for i in 1..20` loop; capture `xcrun simctl spawn <UDID> log stream`
alongside. To emulate CI's slow shared runners, run 2 sims + a parallel
`yes > /dev/null &` load, or `taskpolicy -c background xcodebuild ...`.

## Hypotheses to test, ranked

1. Backgrounding transitions under load overrun the Swift waits.
   Both top flakes background the app (`XCUIDevice.shared.press(.home)`
   style) and re-activate; RecordingUITests uses hard
   `Thread.sleep(30/15/13/10)` plus `waitForExistence(15..60)`. Under
   load, springboard animations + app re-activation can exceed the
   shorter waits. Instrument: timestamps around each sleep/wait in a
   local slow-run; find which wait actually trips.
2. The waypoint test additionally depends on the HOST location playback
   re-crossing the dropped pin within one lap (~60 s, see run.sh) and on
   speech/announcement timing while backgrounded. If the sim clock and
   the host playback drift under load, the re-cross window slides.
   Instrument: log fix timestamps in-app vs wall clock.
3. First-launch cold start (KeyboardUITests): one confirmed launch
   timeout. Cheap insurance regardless of 1/2: pre-warm in run.sh
   (launch + terminate once before the suite) or raise the first
   launch timeout.

## Speed levers (est. -3 to -5 min of 14)

1. The ~70 s of hard Thread.sleep in RecordingUITests exists to let the
   backgrounded engine accumulate fixes at 1 Hz. The assertions only
   need "several fixes while backgrounded" — measure whether 30 s
   windows can shrink to ~10 s without weakening what is proven
   (engine records at 1 Hz; 10 s ≈ 10 fixes). Candidate saving: ~60 s.
2. Boot+install (166 s): try `xcrun simctl bootstatus -b` to overlap
   boot with the app build step, and check whether the runner image's
   preferred runtime avoids a runtime download.
3. Build (247 s): verify swatinem/rust-cache is actually hitting for the
   aarch64-sim target (cache key vs target triple), and whether
   xcodebuild's derived data can be cached keyed on the Swift sources.

## Ground rules

- Zero-retry philosophy: fix causes, never add retries or blind sleeps.
- Do not weaken assertions; extend PRECONDITION waits only, with a
  comment saying why.
- ios-tests/*.swift probe the WKWebView accessibility tree — DOM tag
  changes in src/ui can shift it (see repo memory: a div->button swap
  broke these tests once). If a wait change doesn't fix a flake, diff
  the AX tree before blaming timing.
- Every change lands as a PR; CI's sim job is the arbiter (~15 min per
  iteration — batch experiments locally first).
