import {
  chevronDownOutline,
  footstepsOutline,
  pause,
  play,
  refresh,
  stop as stopIcon,
} from "ionicons/icons";
import { useEffect, useEffectEvent } from "react";

import type { Fix } from "../../engine/types";
import {
  formatAltitude,
  formatClimb,
  formatCourse,
  formatDuration,
  formatSpeed,
} from "../../flight/format";
import NativeIcon from "../components/NativeIcon";
import { cx } from "../cx";
import type { MapView } from "../map/types";
import { useSettings } from "../settings/SettingsContext";
import Barogram from "./Barogram";
import Readout from "./Readout";
import {
  recallTimeline,
  rememberPosition,
  rememberView,
} from "./timelineMemory";
import { useReplayFeed } from "./useReplayFeed";
import { type ReplayCamera, useReplayMapDriver } from "./useReplayMapDriver";

import mapCss from "../map/map.module.css";
import chassis from "./dock.module.css";
import styles from "./ReplayDock.module.css";

interface ReplayDockProps {
  // The HOST's map (the seat map, the fullscreen detail map); null while
  // it is still loading — the dock renders and drives it once ready.
  map: MapView | null;
  track: Fix[];
  // Scopes the timeline memory (position + zoom continuity across dock
  // swaps): the flight id.
  timelineKey: string;
  // Start playing on mount (the drawer's play button just opened us).
  autoplay?: boolean;
  // Owned by the drawer hook (the camera buttons live in the host's map
  // control stack); the driver here consumes it.
  camera: ReplayCamera;
  onFollowBroken: () => void;
  // Parked/live state is the drawer's too (the camera buttons only exist
  // while the aircraft is on the map); the dock reports transitions.
  active: boolean;
  onActiveChange: (active: boolean) => void;
  // Draw-along mode: hide the path ahead of the aircraft.
  hideAhead: boolean;
  onToggleHideAhead: () => void;
  // Parked, the stop button becomes the collapse chevron.
  onCollapse: () => void;
  // The desktop seat's presentation (dock.module.css .seat variant).
  seat?: boolean;
}

/**
 * The playback pane docked under a flight map: live readouts, the
 * zoomable barogram scrubber, and transport controls, driving the host
 * map's aircraft glyph. Scrubbing while paused previews that moment on
 * the map. PARKED (mounted without autoplay, or after the stop button:
 * halted, rewound) the glyph stays off the map — the pane is just the
 * flight's graph until play or a scrub wakes it. Mount keyed per flight
 * (the feed binds to one track).
 */
export default function ReplayDock({
  map,
  track,
  timelineKey,
  autoplay,
  camera,
  onFollowBroken,
  active,
  onActiveChange,
  hideAhead,
  onToggleHideAhead,
  onCollapse,
  seat = false,
}: ReplayDockProps) {
  const { units } = useSettings();
  // Timeline continuity: pick up where the previous dock (a clip
  // editor's cut point, an earlier session on this flight) left off.
  const feed = useReplayFeed(track, autoplay, recallTimeline(timelineKey).at);

  const reportPosition = useEffectEvent(() =>
    rememberPosition(timelineKey, feed.simTime),
  );

  useEffect(() => {
    reportPosition();
  }, [feed.simTime]);
  useReplayMapDriver(
    map,
    active ? feed.latest : null,
    active && hideAhead ? feed.track : null,
    camera,
    onFollowBroken,
  );

  // Space is play/pause anywhere while the pane is open, focus-blind (the
  // media idiom): clicking play used to leave the button focused so native
  // Space re-activation LOOKED like a shortcut, then a scrub moved focus
  // to the slider and it "broke". preventDefault also suppresses the
  // focused button's own Space activation (no double toggle) and the page
  // scroll; Enter still activates buttons normally. Yields to typing.
  const toggleFromKeyboard = useEffectEvent(() => {
    onActiveChange(true);
    feed.togglePlay();
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== " ") return;
      const target = event.target as HTMLElement | null;
      // Yield to typing AND to any presented Ionic overlay: Space must
      // activate a focused sheet/popover/alert button, not drive playback
      // behind the modal.
      if (
        target?.closest(
          "input, textarea, ion-input, ion-textarea, ion-alert, ion-action-sheet, ion-popover, ion-modal",
        )
      ) {
        return;
      }
      event.preventDefault();
      toggleFromKeyboard();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const first = track[0];
  const latest = feed.latest;

  return (
    <div
      className={cx(chassis.dock, seat && chassis.seat)}
      data-testid="replay-dock"
    >
      <div className={chassis.readouts}>
        <Readout
          label="Above launch"
          accent="cyan"
          testId="replay-agl"
          value={formatAltitude(latest.altitude - first.altitude, units)}
        />
        <Readout
          label="Altitude MSL"
          testId="replay-msl"
          value={formatAltitude(latest.altitude, units)}
        />
        <Readout
          label="Speed"
          accent="green"
          testId="replay-ground-speed"
          value={formatSpeed(latest.speed, units)}
        />
        <Readout
          label="Climb"
          accent="yellow"
          testId="replay-climb"
          value={formatClimb(latest.climbRate, units)}
        />
        <Readout
          label="Course"
          accent="yellow"
          testId="replay-course"
          value={formatCourse(latest.course)}
        />
      </div>
      <Barogram
        track={track}
        simTime={feed.simTime}
        playhead={active}
        onSeek={feed.seek}
        onScrubStart={() => {
          onActiveChange(true);
          feed.beginScrub();
        }}
        onScrubEnd={feed.endScrub}
        initialView={recallTimeline(timelineKey).view}
        onViewChange={(view) => rememberView(timelineKey, view)}
      />
      <div className={styles.transport}>
        <button
          className={mapCss.button}
          data-testid="replay-play"
          aria-label={
            feed.playing ? "Pause" : feed.atEnd ? "Replay again" : "Play"
          }
          onClick={() => {
            onActiveChange(true);
            feed.togglePlay();
          }}
        >
          <NativeIcon
            icon={feed.playing ? pause : feed.atEnd ? refresh : play}
          />
        </button>
        <div className={styles.time} data-testid="replay-time">
          {formatDuration(feed.elapsedSeconds)}
          <span className={styles.timeTotal}>
            {" / "}
            {formatDuration(feed.totalSeconds)}
          </span>
        </div>
        <div className={styles.spring} />
        {/* Lit = the WHOLE line is on show; unlit = draw-along, only the
            flown path (per Alex). The label names the action a press
            takes, so it reads opposite to the lit state. */}
        <button
          className={mapCss.button}
          data-testid="replay-trail"
          aria-label={
            hideAhead ? "Show the whole track" : "Hide the path ahead"
          }
          data-active={!hideAhead}
          onClick={onToggleHideAhead}
        >
          <NativeIcon icon={footstepsOutline} />
        </button>
        <button
          className={cx(mapCss.button, styles.speed)}
          data-testid="replay-speed"
          aria-label="Playback speed"
          onClick={feed.cycleSpeed}
        >
          {feed.speed}×
        </button>
        <button
          className={mapCss.button}
          data-testid="replay-stop"
          aria-label={active ? "Stop replay" : "Hide replay"}
          onClick={() => {
            if (active) {
              onActiveChange(false);
              feed.stop();
              return;
            }
            // Already parked: the stop IS the collapse.
            onCollapse();
          }}
        >
          <NativeIcon icon={active ? stopIcon : chevronDownOutline} />
        </button>
      </div>
    </div>
  );
}
