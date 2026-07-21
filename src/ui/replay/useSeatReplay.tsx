import { contractOutline, expandOutline, play } from "ionicons/icons";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { isTauri } from "../../engine/platform";
import type { Fix } from "../../engine/types";
import type { Flight } from "../../storage/db";
import NativeIcon from "../components/NativeIcon";
import { replayAvailable } from "./available";
import ReplayPlayer from "./ReplayPlayer";

type SeatReplayMode = "closed" | "card" | "full";

/**
 * Desktop host glue for the replay player: a phone-aspect card centered
 * over the seat map (a scrim behind it), expandable to the full window.
 * Packaged as a hook so FlightSeat stays within its state budget; the
 * seat renders `button` in its map-overlay stack and `element` inside
 * .seat-map.
 */
export function useSeatReplay(
  flight: Flight | null,
  track: Fix[],
  // False while the logbook section is URL-hidden; the player must close
  // with its section rather than play on, invisibly.
  active: boolean,
): { button: ReactNode; element: ReactNode } {
  const [mode, setMode] = useState<SeatReplayMode>("closed");
  // The async fullscreen grant can land after a quick shrink; the callback
  // must see the CURRENT intent (the fullscreen-map pattern).
  const modeRef = useRef<SeatReplayMode>("closed");

  // Arrow-key flight switching swaps the seat's id under us: a replay of
  // flight A must not keep playing over flight B. Likewise the player must
  // close with its URL-hidden section rather than play on, invisibly.
  // State adjusted during render (not an effect) per React doctrine.
  const [seenId, setSeenId] = useState(flight?.id);
  if (seenId !== flight?.id) {
    setSeenId(flight?.id);
    if (mode !== "closed") setMode("closed");
  }
  if (!active && mode !== "closed") setMode("closed");

  // Esc steps down: fullscreen → card → closed. (Leaving browser
  // fullscreen is handled by the fullscreenchange fold below; this
  // keydown covers the same step when the grant never landed.)
  useEffect(() => {
    if (mode === "closed") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMode(mode === "full" ? "card" : "closed");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode]);

  // Browser fullscreen rides along with the expanded card on the PWA —
  // unless the seat's fullscreen map already holds the grant, which then
  // stays its own.
  useEffect(() => {
    modeRef.current = mode;
    if (mode !== "full" || isTauri()) return;
    const owned = !document.fullscreenElement;
    if (owned) {
      void document.documentElement
        .requestFullscreen?.()
        .then(() => {
          if (modeRef.current !== "full" && document.fullscreenElement) {
            void document.exitFullscreen().catch(() => {});
          }
        })
        .catch(() => {});
    }
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) setMode("card");
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      if (owned && document.fullscreenElement) {
        void document.exitFullscreen().catch(() => {});
      }
    };
  }, [mode]);

  const available = replayAvailable(flight, track);

  return {
    button: available ? (
      <button
        className="map-button"
        aria-label="Replay flight"
        data-testid="seat-replay"
        onClick={() => setMode("card")}
      >
        <NativeIcon icon={play} />
      </button>
    ) : null,
    element:
      mode !== "closed" && flight && available ? (
        <div
          className="replay-scrim"
          data-testid="replay-scrim"
          onClick={() => setMode("closed")}
        >
          <div
            className={mode === "full" ? "replay-phone full" : "replay-phone"}
            onClick={(event) => event.stopPropagation()}
          >
            <ReplayPlayer
              key={flight.id}
              flight={flight}
              track={track}
              onClose={() => setMode("closed")}
              actions={
                <button
                  className="map-button"
                  aria-label={mode === "full" ? "Shrink player" : "Expand player"}
                  data-testid="replay-expand"
                  onClick={() => setMode(mode === "full" ? "card" : "full")}
                >
                  <NativeIcon
                    icon={mode === "full" ? contractOutline : expandOutline}
                  />
                </button>
              }
            />
          </div>
        </div>
      ) : null,
  };
}
