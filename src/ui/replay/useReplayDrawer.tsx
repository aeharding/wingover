import { compassOutline, locateOutline, play } from "ionicons/icons";
import { type ReactNode, useEffect, useState } from "react";

import type { Fix } from "../../engine/types";
import type { Flight } from "../../storage/db";
import NativeIcon from "../components/NativeIcon";
import { afterNextFrame } from "../map/afterFrame";
import type { MapView } from "../map/types";
import { replayAvailable } from "./available";
import ReplayDock from "./ReplayDock";

import "./ReplayDrawer.css";

// closed → opening (mounted at 0fr) → open (1fr, the slide runs) →
// closing (back to 0fr) → closed (unmount tears the aircraft down).
type DrawerPhase = "closed" | "opening" | "open" | "closing";

/**
 * Host glue for the replay pane: a floating play button while closed; the
 * dock sliding open in flow (pushing the map up) when pressed, playing;
 * the fly-page camera controls (follow, track-up) while open; a stop
 * button closing it back down. Packaged as a hook so the hosts stay
 * within their state budgets — they render the returned nodes:
 * `playButton` and `cameraButtons` in their map control stack, `drawer`
 * below their map region.
 */
export function useReplayDrawer(
  map: MapView | null,
  track: Fix[],
  flight: Flight | null,
  // False while the host surface is hidden (the phone's inline preview, a
  // URL-hidden desktop section): the drawer closes with it.
  enabled = true,
): {
  available: boolean;
  isOpen: boolean;
  open: () => void;
  playButton: ReactNode;
  cameraButtons: ReactNode;
  drawer: ReactNode;
} {
  const [phase, setPhase] = useState<DrawerPhase>("closed");
  // The fly-page camera modes, per replay session (reset on open).
  // Overview is the default: the pilot watches the dot fly the framed
  // track, and locks on when they want the in-flight view.
  const [camera, setCamera] = useState({ follow: false, trackUp: false });

  // Close when the flight changes or the host hides — a replay of flight
  // A must not keep playing over flight B, or invisibly. Render-adjusted
  // (guarded, converging), never in an effect.
  const [seenId, setSeenId] = useState(flight?.id);
  if (seenId !== flight?.id) {
    setSeenId(flight?.id);
    if (phase !== "closed") setPhase("closed");
  }
  if (!enabled && phase !== "closed") setPhase("closed");

  // Mounted collapsed (0fr), the drawer opens on the NEXT frame so the
  // grid-rows transition actually slides.
  useEffect(() => {
    if (phase !== "opening") return;
    return afterNextFrame(() => setPhase("open"));
  }, [phase]);

  const available = replayAvailable(flight, track);

  function open() {
    setCamera({ follow: false, trackUp: false });
    setPhase("opening");
  }

  function stop() {
    // Without a transition there is no transitionend to finish the close.
    setPhase(
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "closed"
        : "closing",
    );
  }

  const isOpen = phase !== "closed";

  return {
    available,
    isOpen,
    open,
    playButton:
      available && enabled && !isOpen ? (
        <button
          className="map-button"
          aria-label="Replay flight"
          data-testid="replay-start"
          onClick={open}
        >
          <NativeIcon icon={play} />
        </button>
      ) : null,
    cameraButtons: isOpen ? (
      <>
        <button
          className="map-button"
          aria-label={camera.follow ? "Track up" : "Align north"}
          data-active={camera.follow && camera.trackUp}
          data-testid="replay-trackup"
          onClick={() => {
            if (camera.follow) {
              setCamera((prior) => ({ ...prior, trackUp: !prior.trackUp }));
              return;
            }
            // Unsnapped, the compass is a north reset (fly-page semantics,
            // eased here — ground maps may animate).
            map?.moveTo({ bearing: 0 }, { animate: true });
          }}
        >
          <NativeIcon icon={compassOutline} />
        </button>
        <button
          className="map-button"
          aria-label="Follow aircraft"
          data-active={camera.follow}
          data-testid="replay-follow"
          onClick={() =>
            // Unfollowing drops track-up with it, so resuming is two
            // deliberate presses (fly-page semantics).
            setCamera((prior) =>
              prior.follow
                ? { follow: false, trackUp: false }
                : { ...prior, follow: true },
            )
          }
        >
          <NativeIcon icon={locateOutline} />
        </button>
      </>
    ) : null,
    drawer:
      available && flight && isOpen ? (
        <div
          className={phase === "open" ? "replay-drawer open" : "replay-drawer"}
          onTransitionEnd={(event) => {
            if (
              phase === "closing" &&
              event.propertyName === "grid-template-rows"
            ) {
              setPhase("closed");
            }
          }}
        >
          <div className="replay-drawer-clip">
            <ReplayDock
              key={flight.id}
              map={map}
              track={track}
              autoplay
              camera={camera}
              onFollowBroken={() =>
                setCamera({ follow: false, trackUp: false })
              }
              onStop={stop}
            />
          </div>
        </div>
      ) : null,
  };
}
