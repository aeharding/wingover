import { close, pause, play, refresh } from "ionicons/icons";
import type { ReactNode } from "react";

import type { Fix } from "../../engine/types";
import { formatDuration } from "../../flight/format";
import NativeIcon from "../components/NativeIcon";
import Barogram from "./Barogram";
import type { ReplayFeed } from "./useReplayFeed";

import "./ReplayBar.css";

interface ReplayBarProps {
  feed: ReplayFeed;
  // The whole flight, for the barogram timeline.
  track: Fix[];
  onClose: () => void;
  // Host-specific extras (the desktop card's expand button).
  actions?: ReactNode;
}

/**
 * The playback control surface docked under the player map: barogram scrub
 * track above a transport row. Gloves-first: every control is a full
 * .map-button square.
 */
export default function ReplayBar({
  feed,
  track,
  onClose,
  actions,
}: ReplayBarProps) {
  return (
    <div className="replay-bar">
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
          aria-label={feed.playing ? "Pause" : feed.atEnd ? "Replay again" : "Play"}
          onClick={feed.togglePlay}
        >
          <NativeIcon icon={feed.playing ? pause : feed.atEnd ? refresh : play} />
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
        {actions}
        <button
          className="map-button"
          data-testid="replay-close"
          aria-label="Close replay"
          onClick={onClose}
        >
          <NativeIcon icon={close} />
        </button>
      </div>
    </div>
  );
}
