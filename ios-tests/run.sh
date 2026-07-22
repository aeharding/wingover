#!/bin/bash
# Runs the XCUITest suite against a booted simulator that already has the
# app installed (CI installs the aarch64-sim build first; locally, install
# whatever build you're testing). Single source for CI and local runs.
#
# Usage: ios-tests/run.sh <sim-udid>
set -euo pipefail
UDID="$1"
cd "$(dirname "$0")"

# The flight tests' prerequisites, both host-side:
#  - location permission granted up front, so no springboard alert races
#    the tests;
#  - a flight's worth of motion streaming: out-and-back 1.2 km laps at
#    40 m/s (well past the 4.5 m/s takeoff threshold; speed is the suite's
#    master pace knob), fresh fixes at 1 Hz, ~60 min of playback, sized to
#    outlive the whole suite (the first launch's compile and pre-warm can
#    burn minutes before the movement test even starts). The scenario runs
#    on the HOST, so it keeps feeding
#    CoreLocation while the app is backgrounded — which is the point. Laps,
#    not a one-way line, because the waypoint test drops a pin at "wherever
#    the sim is right now" and relies on the path re-crossing that spot
#    within one lap (~60 s).
xcrun simctl privacy "$UDID" grant location app.wingover.wingover
xcrun simctl location "$UDID" clear
xcrun simctl location "$UDID" start --speed=40 --interval=1 - <flight-path.txt

# Pre-warm: the first launch of a fresh install on a cold simulator can
# exceed XCUITest's launch timeout on CI runners (observed: "Timed out
# attempting to launch app" on the suite's first test). Launch once outside
# the test session, let dyld/WebKit warm up, terminate.
xcrun simctl launch "$UDID" app.wingover.wingover
sleep 10
xcrun simctl terminate "$UDID" app.wingover.wingover 2>/dev/null || true

# The runner reads the app's native session log to prove fixes keep landing
# while the app is backgrounded. TEST_RUNNER_-prefixed variables reach the
# runner's environment.
DATA_DIR=$(xcrun simctl get_app_container "$UDID" app.wingover.wingover data)

# -collect-test-diagnostics never is load-bearing: a failing run otherwise
# embeds the sim's full logarchive in the xcresult (multi-GB; it has filled
# a disk).
TEST_RUNNER_WINGOVER_DATA="$DATA_DIR" xcodebuild test \
  -project WingoverUITests.xcodeproj \
  -scheme WingoverUITests \
  -destination "id=$UDID" \
  -collect-test-diagnostics never

xcrun simctl location "$UDID" clear
