# Return guidance

Return guidance is a derived in-flight view. It does not alter recording,
persist guidance state, call a network service, or learn from a pilot's flights
in production. Every value is recomputed from the recorded fix prefix and the
active navigation target.

## In-flight contract

The flight surface keeps its existing eight tiles and existing row height.

- In ordinary daylight, the target tile reads `To launch` or `To waypoint`.
  Distance remains on the left and a green unsigned ETA such as `:12` appears
  on the right. If the track cannot support an estimate yet, the split is not
  shown.
- From 30 minutes before sunset through 60 minutes after it, `Duration` splits
  to show the current sunset
  offset, such as `S−03`. The target tile replaces ordinary ETA with projected
  arrival relative to the same sunset, such as `S+02`. Both offsets use the
  same magenta. There is no separate legal-time line.
- Sunset mode uses the pilot's current coordinates, independently of the
  navigation target. It appears from 30 minutes before that sunset through 60
  minutes after it, including for a flight launched inside the post-sunset
  window. Reaching or changing a waypoint cannot move the reference. Morning
  flight does not show the previous sunset, and active flight never shows
  sunrise.
- ETA is rounded up to the next minute. Current sunset time counts down before
  sunset and counts elapsed whole minutes after it. Projected sunset arrival
  rounds toward the later minute.
- Launch arrival disappears inside one mile, where the remaining estimate is
  no longer useful. Arrival for any target disappears at one minute or less.
  The target distance remains visible in both cases.
- Waypoints use the same target-independent estimator and compact tile split.
  Labels stay generic because in-flight waypoints are anonymous. Direction-edge
  guidance is launch-only in this version.

Recorded-flight replay includes a temporary `RTL debug` overlay. `UI sunset`
and `UI launch` are the exact compact values the flight tiles would render at
the playhead. `Sunset raw` and `Arrival raw` remain visible before the sunset
gate opens, while exact ETA, selected speed, fallback model, recent
target-course sample, course, bearing, and error expose estimator handoffs.
This panel exists only in playback and does not add a live-flight stat line.

The direction hint is one full-strength green edge on the side the pilot should
turn toward. It is fine guidance, not a return alert. It appears only when all
of these are true:

- the target is launch;
- the flight has reached 1.2 miles from launch and remains more than 1 mile
  away;
- the last 12 seconds are continuous, accurate, closing on launch, and within
  30 degrees of the target;
- a 5 to 20 degree error persists on the same side;
- the pilot is not turning quickly or already correcting the error.

Aligned flight, a large course error, circling, gaps, poor accuracy, movement
away from launch, and the inner mile all show no edge.

## Speed estimate

Ground-velocity samples are grouped by course. With at least 90 degrees of
useful heading coverage, their velocity endpoints constrain a circle:

```text
observed ground velocity = wind vector + airspeed vector
```

The fitted circle center estimates wind and its radius estimates the airspeed
represented by the sampled flight. Projecting that circle onto the bearing to
the target gives expected groundspeed on the return course. The production
estimate subtracts a residual-based uncertainty allowance. A high-residual fit
or insufficient heading coverage is withheld.

ETA does not wait for that wind model when the track contains direct evidence
for the target course. Three maneuver-filtered samples spanning at least two
seconds within 15 degrees of the target qualify a target-course estimate. Its
speed is a trimmed mean of the latest five seconds in that encounter. Fresh
evidence begins moving ETA as soon as it qualifies and reaches full confidence
over six seconds. Once a continuous inbound leg has held within 10 degrees for
12 seconds, its measured groundspeed receives full weight. Neither path needs
the algorithm to identify wind direction or airspeed first. Isolated fixes,
rapid turns, steep climbs, poor accuracy, and encounters outside the course
window do not qualify.

The adaptive model filters rapid turns, steep climbs, and coupled horizontal
and vertical acceleration within a two-second window, then fits 10, 15, and
30-minute horizons. The coupled check catches wingovers and same-course
throttle oscillations without treating a clean groundspeed change as a
maneuver. Samples have full weight within 100 meters of the current altitude,
then fade to zero at 500 meters so a model learned at another flight level is
not published as current wind. The oldest 10% of each time horizon fades to
zero instead of falling out on one fix.

Each course bin earns support continuously and reaches full statistical weight
after six seconds of usable evidence. The circle itself is a weighted
least-squares fit with one continuous robust reweighting pass. Covariance from
that fit is projected directly onto target-course groundspeed, so uncertainty
in irrelevant wind-vector components does not suppress a useful ETA. A short
fit with high projected uncertainty moves continuously toward the valid
30-minute estimate; it is neither accepted at full weight nor switched off at
a threshold.

The production blend gives nominal weights of 35% to the 10-minute fit, 15% to
the 15-minute fit, and 50% to the 30-minute fit. It contains no rolling ETA
average, delayed output buffer, or other temporal smoothing. A sustained,
well-constrained change therefore moves the current estimate immediately,
while weak new geometry has little leverage until it supports its claim. Every
published 30-minute model must pass the projected-speed uncertainty check.
Valid positive return speeds down to one meter per second remain eligible, so
a strong headwind does not make a slow but possible return disappear.

Before either target-course path qualifies, an aligned current groundspeed is
a last-resort estimate when the circle is not yet constrained.

Turning away does not discard a target-course measurement. Its contribution
fades over 30 minutes, matching the longest evidence retained by the wind
model. At the end of the fade, that model contains no samples from before the
direct measurement. A change in altitude beyond 100 meters also begins fading
it and 500 meters retires it. Target-course evidence has full directional
confidence through 10 degrees and retires at 20 degrees; the longer 12-second
calibration can remain useful through 45 degrees. All calibration is derived
from the in-memory flight track and target. Nothing new is persisted.

This cannot predict a future trimmer or speed-bar change. It observes the
settings already represented in the track, then adapts after the pilot changes
the actual closing speed.

## Local historical backtest

Run against an explicitly supplied local GPX directory:

```sh
pnpm backtest:rtl /absolute/path/to/gpx-directory
```

The command never searches for flights, writes them, or adds them to the app.
The raw corpus stays outside the repository. It calls the production guidance
derivation and display-availability policy, and uses the same ETA minute-rounding
function as the flight surface. Prediction and actual time both stop at the
interpolated 200-meter LZ boundary. The return-start prefix includes the fix at
which the return begins.

GPX contains positions, altitude, and time, so the runner reconstructs speed,
course, and climb from those points. GPX has no native accuracy fields; the
reconstructed fixes use zero as the existing unknown-accuracy sentinel, which
means this corpus does not validate production sensor-accuracy rejection. Exact
replay checks use the browser's stored sensor track when validating a reported
sensor-field jump.

The August 31, 2026 run parsed 309 unique local GPX files. Nineteen never
traveled 1.5 miles from launch, 44 ended away from launch, and 246 ended within
500 meters. Of those ending nearby, 175 reached the 200-meter boundary through
a qualifying final inbound leg; 71 did not. Accuracy rates below are conditional
on those 175 successful qualifying RTLs. They do not measure land-outs, aborted
returns, or flights where no qualifying return could be identified.

The newest 30% by flight date is a 53-flight chronological evaluation slice,
not an untouched holdout. The tool deliberately prints experiments for that
slice, so subsequent changes can tune against it. A true holdout requires new
flights or a sealed manifest after the algorithm is frozen.

At the start of the return leg, production guidance was available on 52 of the
53 evaluation flights. It had 1.00 minute median absolute error, 3.98 minutes at
p90, 5.61 minutes at p95, and -0.08 minute mean bias. It underestimated return
time by more than two minutes on 8/52 flights (15%). Instantaneous groundspeed,
with identical minute rounding, had 1.43 minute median error, 4.57 minutes at
p90, 6.62 minutes at p95, -1.13 minute mean bias, and underestimated by more
than two minutes on 16/53 flights (30%).

On the 27 evaluation flights whose return path was at least 90% efficient,
production guidance had 0.92 minute median error, 3.98 minutes at p90, 5.61
minutes at p95, and underestimated by more than two minutes on 2/27 flights
(7%). Three seconds into the stable inbound leg the corresponding values were
0.95, 4.03, and 4.66 minutes, with 2/27 underestimates. At 12 seconds they were
0.56, 2.27, and 4.18 minutes, with 1/27 underestimates. Tail percentiles use the
nearest-rank convention; counts are shown because this is a small sample.

The manually identified May 11, 2026 wind-change flight is a separate labeled
check because it ended in a land-out rather than a return to launch. On the
actual launch bearing, exact stored replay ETA moves from 25.6 minutes at
minute 61 to 32.1 at minute 65, 35.4 at minute 67, 41.1 at minute 71, and 43.7
at minute 75. It reaches 45.7 minutes by minute 80. Across that wind-change
interval, the largest one-fix ETA move is 1.09 raw minutes and one displayed
minute, with no temporal output smoothing. Near the end, bearing to launch was
about 210 to 215 degrees while the pilot was generally 40 to 90 degrees off
that bearing; the brief aligned points did not form a stable direct-to-launch
encounter.

The reported August 30, 2025 replay was also checked from the exact compressed
track stored by the browser, not a GPX reconstruction. A weak 10-minute fit
previously received full influence and caused the erroneous jump. Projected
fit uncertainty now keeps that evidence near the 30-minute estimate until its
geometry is useful. Around 1:29:47 through 1:29:49, ETA stays near 17.9 minutes
and projected arrival stays near four minutes before sunset. Around 1:25:45,
ETA stays near 17.3 minutes instead of switching horizons.

The deterministic pressure simulation covers a one-fix speed spike,
same-course throttle and vertical oscillation, a sustained direct headwind
increase, acquiring target-course evidence without a prior calibration,
turning away after calibration, source cadence, and the eventual short-model
handoff. The spike and oscillation do not replace stable evidence, a sustained
direct change is fully reflected within five seconds, and no one-fix simulated
model handoff exceeds 0.5 meters per second.

Two compressed real-flight regressions are checked in under
`src/flight/test-fixtures`. Their Earth geometry and course tangents were
rotated to unrelated coordinates, absolute dates were replaced, launch
altitudes were replaced while retaining only altitude deltas, and each track
was trimmed to the required 30-minute history and failure interval. Unit tests
pin every known transition neighborhood and the reported replay timestamps.
The original coordinates, timestamps, and launch altitudes are not present in
the repository.

On the 6,656-fix August replay, 300 repeated desktop runs averaged 0.47
milliseconds for the adaptive model. Full replay diagnostics, including the
model and target-course sampling, averaged 0.77 milliseconds. That is below
0.1% of one desktop core at a one-hertz fix rate. This is a bounded duty-cycle
check, not an iPhone battery or thermal measurement; the real-device power
drill remains required.

The corpus is one pilot's history and the arrival threshold is 200 meters, so
these measurements are a regression baseline, not a guarantee for every wing,
site, or future control input.
