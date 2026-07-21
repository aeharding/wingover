import { pause, play, refresh } from "ionicons/icons";

import type { Fix } from "../../engine/types";
import {
  formatAltitude,
  formatClimb,
  formatCourse,
  formatDuration,
  formatSpeed,
} from "../../flight/format";
import NativeIcon from "../components/NativeIcon";
import type { MapView } from "../map/types";
import { useSettings } from "../settings/SettingsContext";
import Barogram from "./Barogram";
import { useReplayFeed } from "./useReplayFeed";
import { useReplayMapDriver } from "./useReplayMapDriver";

import "./ReplayDock.css";

interface ReplayDockProps {
  // The HOST's map (the seat map, the fullscreen detail map); null while
  // it is still loading — the dock renders and drives it once ready.
  map: MapView | null;
  track: Fix[];
  // Start playing on mount (the phone's Replay pill).
  autoplay?: boolean;
}

/**
 * The playback bar docked under a flight map: live readouts, the zoomable
 * barogram scrubber, and transport controls, driving the host map's
 * aircraft glyph. It is the flight's altitude graph even when nothing is
 * playing — scrubbing while paused previews that moment on the map.
 * Mount keyed per flight (the feed binds to one track).
 */
export default function ReplayDock({ map, track, autoplay }: ReplayDockProps) {
  const { units } = useSettings();
  const feed = useReplayFeed(track, autoplay);
  useReplayMapDriver(map, feed.latest);

  const first = track[0];
  const latest = feed.latest;

  return (
    <div className="replay-dock" data-testid="replay-dock">
      <div className="replay-readouts">
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
        onSeek={feed.seek}
        onScrubStart={feed.beginScrub}
        onScrubEnd={feed.endScrub}
      />
      <div className="replay-transport">
        <button
          className="map-button"
          data-testid="replay-play"
          aria-label={
            feed.playing ? "Pause" : feed.atEnd ? "Replay again" : "Play"
          }
          onClick={feed.togglePlay}
        >
          <NativeIcon
            icon={feed.playing ? pause : feed.atEnd ? refresh : play}
          />
        </button>
        <div className="replay-time" data-testid="replay-time">
          {formatDuration(feed.elapsedSeconds)}
          <span className="replay-time-total">
            {" / "}
            {formatDuration(feed.totalSeconds)}
          </span>
        </div>
        <div className="replay-transport-spring" />
        <button
          className="map-button replay-speed"
          data-testid="replay-speed"
          aria-label="Playback speed"
          onClick={feed.cycleSpeed}
        >
          {feed.speed}×
        </button>
      </div>
    </div>
  );
}

function Readout({
  label,
  value,
  accent,
  testId,
}: {
  label: string;
  value: string;
  accent?: "cyan" | "green" | "yellow";
  testId: string;
}) {
  return (
    <div className={accent ? `replay-readout ${accent}` : "replay-readout"}>
      <div className="label">{label}</div>
      <div className="value" data-testid={testId}>
        {value}
      </div>
    </div>
  );
}
