import { useIonAlert } from "@ionic/react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import type { Fix } from "../../engine/types";
import {
  cumulativeDistances,
  MIN_CLIP_SPAN_MS,
  sliceTrack,
  splitTrack,
  windowIndices,
} from "../../flight/clip";
import {
  formatAirtime,
  formatAltitude,
  formatClimb,
  formatCourse,
  formatDistance,
  formatDuration,
  formatSpeed,
} from "../../flight/format";
import {
  ACCENT_CYAN,
  type Line,
  type LngLat,
  type MapView,
  TRACK_LINE_WIDTH_PX,
} from "../map/types";
import { useSettings } from "../settings/SettingsContext";
import Barogram from "./Barogram";
import Readout from "./Readout";
import { cursorFor } from "./replayClock";
import {
  recallTimeline,
  rememberPosition,
  rememberView,
} from "./timelineMemory";
import { useReplayMapDriver } from "./useReplayMapDriver";

import styles from "./ClipDock.module.css";
import chassis from "./dock.module.css";

// One cut point per mode (per Alex: a trim is usually one end or the
// other, so each end is its own errand and the whole editor is a single
// moment to choose).
export type ClipMode = "trim-start" | "trim-end" | "split";

// The second flight's half of a split preview: the launch-marker green,
// against the first half's cyan.
const SPLIT_SECOND_COLOR = "color(display-p3 0.15 0.66 0.3)";

interface ClipDockProps {
  mode: ClipMode;
  // The HOST's map: the clip preview draws its lines and the cut-point
  // glyph there, exactly like playback does.
  map: MapView | null;
  track: Fix[];
  // Scopes the timeline memory (position + zoom continuity across dock
  // swaps): the flight id.
  timelineKey: string;
  onCancel: () => void;
  // The chosen cut time. Resolves once the rewrite landed; a rejection
  // re-enables the controls (the clip visibly did not apply).
  onApply: (cut: number) => Promise<void>;
  // The desktop seat's presentation (dock.module.css .seat variant).
  seat?: boolean;
}

/**
 * The pane's clip mode: ONE cut point, chosen with the barogram's own
 * scrub gesture — tap or drag to the moment, zoom and pan for precision,
 * watch the readouts (speed jumping is the takeoff) — then a red
 * IonAlert confirms the permanent rewrite. No draggable brackets: a
 * single bound needs no grabbable zones fighting the chart's pinch and
 * pan, which is what makes this workable one-thumbed on a phone. The
 * alert is safe above the phone's fullscreen pane because the fullroot
 * lives INSIDE ion-app's stacking context (see FlightDetailPage.css).
 */
export default function ClipDock({
  mode,
  map,
  track,
  timelineKey,
  onCancel,
  onApply,
  seat = false,
}: ClipDockProps) {
  const { units } = useSettings();
  const [presentAlert] = useIonAlert();
  const t0 = track[0].timestamp;
  const t1 = track[track.length - 1].timestamp;
  // Defensive floor: entry is gated on the span outrunning the floor, but
  // a shorter track must still clamp sanely, not invert.
  const minSpanMs = Math.min(MIN_CLIP_SPAN_MS, t1 - t0);
  // What remains (or each half) can never shrink below the floor.
  const cutMin = mode === "trim-start" ? t0 : t0 + minSpanMs;
  const cutMax = mode === "trim-end" ? t1 : t1 - minSpanMs;

  // The cut point IS the scrub position. Seeded from where the pilot
  // already is when that is SANE for the mode (per Alex: pause at the
  // takeoff, choose "Trim start", the cut is right there) — sane means
  // strictly inside the recording AND clear of the mode's floor margins
  // (a position in the last minute presets a start-trim to nearly
  // everything; better to arrive neutral). Otherwise the mode default:
  // trim modes at their own end (nothing cut yet), split at the middle.
  // The pilot can always scrub it elsewhere.
  const [cut, setCut] = useState(() => {
    const at = recallTimeline(timelineKey).at;
    if (at !== null && at > t0 && at < t1 && at >= cutMin && at <= cutMax)
      return at;
    return mode === "trim-start"
      ? t0
      : mode === "trim-end"
        ? t1
        : t0 + (t1 - t0) / 2;
  });
  // True from confirm until the rewrite lands; a rejection re-enables the
  // row (the clip visibly did not apply).
  const [busy, setBusy] = useState(false);
  // The map lines redraw on scrub END, from here — handler closures may
  // be a render stale by then, refs never are.
  const cutRef = useRef(cut);
  const linesRef = useRef<Line[]>([]);

  function moveCut(t: number) {
    const next = Math.min(Math.max(t, cutMin), cutMax);
    cutRef.current = next;
    rememberPosition(timelineKey, next);
    setCut(next);
    // Live recolor while the drag is still moving (per Alex): the kept
    // and cut lines track the cursor, not the release.
    drawLines();
  }

  // The cut-point glyph: same driver as playback, camera disengaged (the
  // host framed the whole flight; the glyph riding the scrub is the
  // preview). It stands on the boundary fix that SURVIVES the cut — for
  // a start trim that is the first KEPT fix (anchoring on the last
  // at-or-before fix left the bright kept line starting one segment
  // ahead of the triangle whenever a fractional cut fell between fixes);
  // for an end trim and a split, the last at-or-before fix IS the kept
  // or shared boundary.
  const cutFix =
    mode === "trim-start"
      ? track[Math.min(windowIndices(track, cut, t1).from, track.length - 1)]
      : track[cursorFor(track, cut) - 1];
  useReplayMapDriver(
    map,
    cutFix,
    null,
    { follow: false, trackUp: false },
    () => {},
  );

  function drawLines() {
    const at = cutRef.current;
    const toLngLat = (fix: Fix): LngLat => [fix.longitude, fix.latitude];
    if (mode === "split") {
      const { first, second } = splitTrack(track, at);
      linesRef.current[0]?.set(first.map(toLngLat));
      linesRef.current[1]?.set(second.map(toLngLat));
    } else {
      const kept =
        mode === "trim-start"
          ? sliceTrack(track, at, t1)
          : sliceTrack(track, t0, at);
      linesRef.current[1]?.set(kept.map(toLngLat));
    }
  }

  const drawOnMount = useEffectEvent(() => drawLines());

  // Trim: the whole recording stays visible but dimmed, with the kept
  // window bright on top. Split: the two halves in their own colors. The
  // host's own track line is blanked while the pane owns it (trackHidden).
  useEffect(() => {
    if (!map) return;
    const lines =
      mode === "split"
        ? [
            map.line({
              color: ACCENT_CYAN,
              width: TRACK_LINE_WIDTH_PX,
              testId: "clip-first",
            }),
            map.line({
              color: SPLIT_SECOND_COLOR,
              width: TRACK_LINE_WIDTH_PX,
              testId: "clip-second",
            }),
          ]
        : [
            map.line({
              color: ACCENT_CYAN,
              width: TRACK_LINE_WIDTH_PX,
              opacity: 0.35,
              testId: "clip-dim",
            }),
            map.line({
              color: ACCENT_CYAN,
              width: TRACK_LINE_WIDTH_PX,
              testId: "clip-kept",
            }),
          ];
    linesRef.current = lines;
    if (mode !== "split") {
      lines[0].set(track.map((fix): LngLat => [fix.longitude, fix.latitude]));
    }
    drawOnMount();
    return () => {
      linesRef.current = [];
      // A provider swap destroys the view before the null onReady lands;
      // cleaning handles on a dead view must not throw the app.
      try {
        for (const line of lines) line.remove();
      } catch {
        // nothing left to clean on a destroyed view
      }
    };
  }, [map, mode, track]);

  // Live preview of what Apply produces. Cumulative distances make the
  // per-scrub cost O(1); the O(n) pass runs once per track.
  const cum = cumulativeDistances(track);
  let preview: string;
  let canApply: boolean;
  if (mode === "split") {
    const last = windowIndices(track, t0, cut).to;
    const firstCount = last + 1;
    // The second half starts AT the shared boundary fix (splitTrack), so
    // it counts and times from track[last] — the durations add up to the
    // whole recording.
    const secondCount = track.length - last;
    canApply = firstCount >= 2 && secondCount >= 2;
    preview = canApply
      ? `${formatAirtime((track[last].timestamp - t0) / 1000)} + ${formatAirtime((t1 - track[last].timestamp) / 1000)}`
      : "Too little on one side";
  } else {
    const { from, to } =
      mode === "trim-start"
        ? windowIndices(track, cut, t1)
        : windowIndices(track, t0, cut);
    const keptCount = to - from + 1;
    const moved = mode === "trim-start" ? cut > t0 : cut < t1;
    canApply = keptCount >= 2 && moved;
    preview =
      keptCount >= 2
        ? `${formatAirtime((track[to].timestamp - track[from].timestamp) / 1000)} · ${formatDistance(cum[to] - cum[from], units)}`
        : "Nothing kept";
  }

  const trim = mode !== "split";

  return (
    <div
      className={seat ? `${chassis.dock} ${chassis.seat}` : chassis.dock}
      data-testid="clip-dock"
    >
      <div className={chassis.readouts}>
        <Readout
          label="Above launch"
          accent="cyan"
          testId="clip-agl"
          value={formatAltitude(cutFix.altitude - track[0].altitude, units)}
        />
        <Readout
          label="Altitude MSL"
          testId="clip-msl"
          value={formatAltitude(cutFix.altitude, units)}
        />
        <Readout
          label="Speed"
          accent="green"
          testId="clip-ground-speed"
          value={formatSpeed(cutFix.speed, units)}
        />
        <Readout
          label="Climb"
          accent="yellow"
          testId="clip-climb"
          value={formatClimb(cutFix.climbRate, units)}
        />
        <Readout
          label="Course"
          accent="yellow"
          testId="clip-course"
          value={formatCourse(cutFix.course)}
        />
      </div>
      <Barogram
        track={track}
        simTime={cut}
        playhead={false}
        onSeek={moveCut}
        onScrubStart={() => {}}
        onScrubEnd={() => {}}
        initialView={recallTimeline(timelineKey).view}
        onViewChange={(view) => rememberView(timelineKey, view)}
        mark={{
          value: cut,
          kind:
            mode === "trim-start"
              ? "start"
              : mode === "trim-end"
                ? "end"
                : "point",
        }}
        kept={
          mode === "trim-start"
            ? { startMs: cut, endMs: t1 }
            : mode === "trim-end"
              ? { startMs: t0, endMs: cut }
              : undefined
        }
      />
      <div className={styles.transport}>
        <button
          className={styles.button}
          data-testid="clip-cancel"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
        <div className={styles.preview} data-testid="clip-preview">
          {preview}
        </div>
        <button
          className={`${styles.button} ${styles.accent}`}
          data-testid="clip-apply"
          disabled={!canApply || busy}
          onClick={() =>
            presentAlert({
              header: trim
                ? mode === "trim-start"
                  ? "Trim the start?"
                  : "Trim the end?"
                : "Split this flight?",
              // Every clip rewrites the recording for good: red confirm
              // button, and the copy quantifies exactly what is removed
              // (per Alex).
              message: trim
                ? `${formatDuration(
                    (mode === "trim-start" ? cut - t0 : t1 - cut) / 1000,
                  )} will be removed from the ${
                    mode === "trim-start" ? "start" : "end"
                  } of the flight. This action is not reversible.`
                : "The recording becomes two flights. This action is not reversible.",
              buttons: [
                { text: "Cancel", role: "cancel" },
                {
                  text: trim ? "Trim" : "Split",
                  role: "destructive",
                  handler: () => {
                    setBusy(true);
                    void onApply(cutRef.current).catch(() => setBusy(false));
                  },
                },
              ],
            })
          }
        >
          {trim ? "Trim…" : "Split…"}
        </button>
      </div>
    </div>
  );
}
