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
- From 30 minutes before sunset, `Duration` splits to show the current sunset
  offset, such as `S−03`. The target tile replaces ordinary ETA with projected
  arrival relative to the same sunset, such as `S+02`. Both offsets use the
  same magenta. There is no separate legal-time line.
- Sunset mode activates only for a flight that reaches the 30-minute window
  before that sunset. Once active, it remains tied to that sunset for the rest
  of the flight. A morning or other later launch does not show the previous
  sunset, and active flight never shows sunrise.
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
and vertical acceleration within a two-second window, then fits 5, 10, 15, and
30-minute horizons. The coupled check catches wingovers and same-course
throttle oscillations without treating a clean groundspeed change as a
maneuver. Samples have full weight within 100 meters of the current altitude,
then fade to zero at 500 meters so a model learned at another flight level is
not published as current wind. Each fit is also checked by removing one
heading bin at a time; a fit that depends heavily on one bin has low
confidence.

The three short horizons are averaged, then blended with the 30-minute model.
The shortest horizon's confidence is averaged over the latest 20 fixes, and
its most recent usable fit is retained through that confirmation window. This
removes one-fix qualification cliffs and model-window chatter while still
letting stable current conditions replace old wind. A sustained, stable
airspeed change can update the model rather than being permanently classified
as noise. The uncertainty-adjusted speed is allowed below the five-meter-per-
second sample floor, so a strong headwind does not erase the conservative
allowance.

Before either target-course path qualifies, an aligned current groundspeed is
a last-resort estimate when the circle is not yet constrained.

Turning away does not discard a target-course measurement. Its contribution
fades across the active wind model's confirmation window: 10 minutes for an
agreeing 5/10-minute model, 15 minutes for an agreeing 10/15-minute model, or 30
minutes for the long fallback. At the end of the fade, that model contains no
samples from before the direct measurement. A change in altitude beyond 100
meters also begins fading it and 500 meters retires it. Target-course evidence
has full directional confidence through 10 degrees and retires at 20 degrees;
the longer 12-second calibration can remain useful through 45 degrees. All
calibration is derived from the in-memory flight track and target. Nothing new
is persisted.

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
derivation for the displayed ETA. GPX contains positions, altitude, and time,
so the runner reconstructs speed, course, and climb from those points. Exact
replay checks use the browser's stored track when validating a reported
sensor-field jump.

The August 30, 2026 run parsed 309 local GPX files. It found 167 flights that
traveled at least 1.5 miles from launch, had an identifiable final inbound leg,
and later reached the 200-meter launch area. The newest 30% by flight date was
held out as 51 flights.

At the start of the return leg, the production display had 1.02 minute median
absolute error, 3.97 minutes at p90, 5.62 minutes at p95, and +0.14 minute mean
bias on the holdout. It underestimated the actual return by more than two
minutes on 14% of flights. Using instantaneous groundspeed instead produced
1.30 minute median error, 6.25 minutes at p90, -1.10 minute mean bias, and a 31%
rate of underestimating by more than two minutes. On the 31 holdout flights
whose return path was at least 90% efficient, the production display had 0.92
minute median error, 3.93 minutes at p90, and 3.97 minutes at p95 with a 6%
hazardous-optimism rate.

On those direct returns, three seconds into the stable inbound leg the display
had 0.97 minute median absolute error, 3.40 minutes at p90, 3.98 minutes at p95,
and a 3% rate of underestimating by more than two minutes. At 12 seconds the
median was 0.83 minute, p90 was 2.27 minutes, p95 was 3.23 minutes, and the
hazardous-optimism rate was 3%. The transition favors a slightly later answer
while fresh evidence gains confidence.

The manually identified May 11, 2026 wind-change flight is a separate labeled
check because it ended in a land-out rather than a return to launch. For a
hypothetical 10-mile upwind leg on course 118, the model shows the sustained
increase as the late wind evidence converges. On the actual launch bearing,
the exact stored replay stays near 26 minutes through minute 71, then moves to
33 minutes at minute 73 and 35 minutes at minute 75. Across minutes 61 through
75, the largest one-fix ETA change is about 1.2 minutes rather than the earlier
20-plus-minute model switch. The target-course samples move from 26.1 mph to
18.9 mph and then 16.1 mph by minute 67. Near the end, bearing to launch was
about 210 to 215 degrees while the pilot was generally 40 to 90 degrees off
that bearing; the brief aligned points did not form a stable direct-to-launch
encounter.

The reported August 30, 2025 replay was also checked from the exact compressed
track stored by the browser, not a GPX reconstruction. Around 1:29:48, raw
short windows inferred 33 to 36 mph and produced the erroneous `S−11`. The
maneuver, fit-sensitivity, and model-confirmation checks suppress that cluster.
Around 1:29:47 through 1:29:49, ETA stays at 17.1 minutes and projected arrival
stays near four minutes before sunset. Around 1:25:45, ETA stays near 15.5
minutes instead of switching horizons.

The deterministic pressure simulation covers a one-fix speed spike,
same-course throttle and vertical oscillation, a sustained direct headwind
increase, acquiring target-course evidence without a prior calibration,
turning away after calibration, and the eventual short-model handoff. The spike
and oscillation do not replace stable evidence, a sustained direct change is
fully reflected within five seconds, and no 15-second handoff step exceeds 0.5
meters per second.

On the 6,656-fix August replay, 100 repeated desktop runs averaged 1.26
milliseconds for the adaptive model and 0.09 milliseconds for target-course
sampling, or about 0.14% of one desktop core at a one-hertz fix rate. This is a
bounded duty-cycle check, not an iPhone battery or thermal measurement; the
real-device power drill remains required.

The corpus is one pilot's history and the arrival threshold is 200 meters, so
these measurements are a regression baseline, not a guarantee for every wing,
site, or future control input.
