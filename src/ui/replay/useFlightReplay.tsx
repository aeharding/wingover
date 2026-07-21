import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { isTauri } from "../../engine/platform";
import type { Fix } from "../../engine/types";
import type { Flight } from "../../storage/db";
import ReplayPlayer from "./ReplayPlayer";

// Shorter than this there is nothing to watch (and the 11-second e2e
// fixture must stay replayable).
const MIN_REPLAY_SPAN_MS = 10_000;

/**
 * Phone host glue for the replay player: open/close state, the body-level
 * fullscreen overlay, and the PWA Fullscreen API ride-along — packaged as a
 * hook so FlightDetailPage stays within its state budget. Render `element`
 * anywhere; it portals to document.body.
 */
export function useFlightReplay(
  flight: Flight | null,
  track: Fix[],
): { available: boolean; open: () => void; element: ReactNode } {
  const [replaying, setReplaying] = useState(false);
  // The async fullscreen grant can land after a quick close; the callback
  // must see the CURRENT intent (the fullscreen-map pattern).
  const replayingRef = useRef(false);

  // Browser fullscreen rides along on the PWA exactly like the fullscreen
  // map: request on open — unless the fullscreen MAP already holds the
  // grant, which then stays its own — and fold the player when Esc or the
  // system gesture exits.
  useEffect(() => {
    replayingRef.current = replaying;
    if (!replaying || isTauri()) return;
    const owned = !document.fullscreenElement;
    if (owned) {
      void document.documentElement
        .requestFullscreen?.()
        .then(() => {
          if (!replayingRef.current && document.fullscreenElement) {
            void document.exitFullscreen().catch(() => {});
          }
        })
        .catch(() => {});
    }
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) setReplaying(false);
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      if (owned && document.fullscreenElement) {
        void document.exitFullscreen().catch(() => {});
      }
    };
  }, [replaying]);

  const available =
    flight !== null &&
    track.length >= 2 &&
    track[track.length - 1].timestamp - track[0].timestamp >=
      MIN_REPLAY_SPAN_MS;

  return {
    available,
    open: () => setReplaying(true),
    element:
      replaying && flight && available
        ? createPortal(
            <div className="replay-fullroot">
              <ReplayPlayer
                key={flight.id}
                flight={flight}
                track={track}
                onClose={() => setReplaying(false)}
              />
            </div>,
            document.body,
          )
        : null,
  };
}
