import {
  chevronDownOutline,
  compassOutline,
  locateOutline,
  play,
} from "ionicons/icons";
import { type ReactNode, useEffect, useState } from "react";

import type { Fix, LngLat } from "../../engine/types";
import { sliceTrack, splitTrack } from "../../flight/clip";
import { computeStats } from "../../flight/stats";
import {
  type Flight,
  inheritedLaunchName,
  rewriteFlightTrack,
  saveFlight,
} from "../../storage/db";
import NativeIcon from "../components/NativeIcon";
import { afterNextFrame } from "../map/afterFrame";
import type { MapView } from "../map/types";
import { replayAvailable } from "./available";
import ClipDock, { type ClipMode } from "./ClipDock";
import ReplayDock from "./ReplayDock";
import { rememberPosition } from "./timelineMemory";

import mapCss from "../map/map.module.css";
import styles from "./ReplayDrawer.module.css";

// closed → opening (mounted at 0fr) → open (1fr, the slide runs) →
// closing (back to 0fr) → closed (unmount tears the aircraft down).
type DrawerPhase = "closed" | "opening" | "open" | "closing";

// The pane is a workspace choice, remembered per device (plain
// localStorage, needed synchronously at first paint — the pane-width
// precedent): a reload or a hidden-section round trip brings it back
// already open, statically, paused. Only stop forgets it.
const PANE_OPEN_KEY = "wingover.replayPane";

function paneWanted(): boolean {
  try {
    return localStorage.getItem(PANE_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberPane(open: boolean): void {
  try {
    if (open) localStorage.setItem(PANE_OPEN_KEY, "1");
    else localStorage.removeItem(PANE_OPEN_KEY);
  } catch {
    return;
  }
}

// "Hide the path ahead" (draw-along replay) is a device preference too,
// like playback speed. Draw-along is the DEFAULT (per Alex: the route
// revealing itself is the replay, the whole track is the opt-out), so
// the stored value marks turning it OFF; a legacy "1" still reads as on.
const HIDE_AHEAD_KEY = "wingover.replayHideAhead";

function storedHideAhead(): boolean {
  try {
    return localStorage.getItem(HIDE_AHEAD_KEY) !== "0";
  } catch {
    return true;
  }
}

function rememberHideAhead(on: boolean): void {
  try {
    if (on) localStorage.removeItem(HIDE_AHEAD_KEY);
    else localStorage.setItem(HIDE_AHEAD_KEY, "0");
  } catch {
    return;
  }
}

/**
 * Host glue for the replay pane: a floating play button while closed; the
 * dock sliding open in flow (pushing the map up) when pressed, playing;
 * the fly-page camera controls (follow, track-up) while open; a stop
 * button closing it back down. The pane OUTLIVES selection: switching
 * flights rebinds it in place (no close, no re-slide), and its open state
 * persists per device. Packaged as a hook so the hosts stay within their
 * state budgets — they render the returned nodes: `playButton` and
 * `cameraButtons` in their map control stack, `drawer` below their map
 * region.
 */
export function useReplayDrawer(
  map: MapView | null,
  track: Fix[],
  flight: Flight | null,
  // False while the host surface is hidden (the phone's inline preview, a
  // URL-hidden desktop section): the pane folds away with it, and comes
  // back with it if it was wanted open.
  enabled = true,
  // The desktop seat hosts the drawer with its own dock presentation.
  seat = false,
): {
  available: boolean;
  isOpen: boolean;
  // True while the pane owns the track line: draw-along replay (the
  // driver draws the flown prefix) or a clip preview (the dock draws the
  // dimmed/kept lines). The host blanks its full line either way.
  trackHidden: boolean;
  open: () => void;
  // Open the pane straight into trim or split mode (the options sheet's
  // entries). Gate on flight/clip's trimAvailable/splitAvailable first.
  beginClip: (mode: ClipMode) => void;
  playButton: ReactNode;
  followButton: ReactNode;
  trackUpButton: ReactNode;
  drawer: ReactNode;
} {
  // phase + WHICH flight's dock should auto-play (only the one the play
  // button was pressed on; switching flights arrives parked, as does a
  // restored pane) + whether the pane is showing playback or a clip
  // editor.
  const [session, setSession] = useState(() => ({
    phase: (paneWanted() ? "open" : "closed") as DrawerPhase,
    autoplayFor: null as string | null,
    mode: "replay" as ClipMode | "replay",
    // The player state stashed when a clip editor opened, restored on
    // exit: leaving trim must hand back EXACTLY the player it borrowed
    // (glyph, follow, track-up), and chained editors (Trim start then
    // Trim end) keep the ORIGINAL stash, not each other's blank slate.
    resume: null as {
      active: boolean;
      camera: { follow: boolean; trackUp: boolean };
    } | null,
  }));
  // The fly-page camera modes; kept across flight switches (continuity),
  // reset on an explicit open.
  const [camera, setCamera] = useState({ follow: false, trackUp: false });
  // Whether the replay is LIVE (aircraft on the map) vs parked (graph
  // only). The camera buttons exist only while live — follow with no
  // subject would lock the zoom anchor to nothing.
  const [active, setActive] = useState(false);
  // Draw-along: hide the path ahead of the aircraft (persisted pref;
  // takes effect only while live — parked shows the whole track).
  const [hideAhead, setHideAhead] = useState(() => storedHideAhead());

  // The last real selection, held through the tens-of-ms track-load gap
  // between flights (useFlightDoc blanks the track while the next one
  // loads): the pane must rebind in place, never collapse and re-slide.
  const [held, setHeld] = useState<{ flight: Flight; track: Fix[] } | null>(
    null,
  );
  if (
    flight &&
    track.length >= 2 &&
    (held?.flight !== flight || held?.track !== track)
  ) {
    // A different flight arrives PARKED: never auto-playing, never
    // following a glyph that is not on the map yet. autoplayFor clears
    // too — otherwise switching BACK to the play-button flight remounts
    // its dock with a playing clock under a parked (glyph-less) pane.
    // A clip editor never survives the switch either: half-dragged trim
    // handles landing on another flight's track would cut the wrong one.
    if (held && held.flight.id !== flight.id) {
      if (active) setActive(false);
      if (session.autoplayFor !== null || session.mode !== "replay") {
        setSession((prior) => ({
          ...prior,
          autoplayFor: null,
          mode: "replay",
          resume: null,
        }));
      }
    }
    setHeld({ flight, track });
  }

  // Continuity vs truth: `available` (from held) keeps the open pane
  // mounted through the tens-of-ms track-load gap; `availableNow` demands
  // the held flight IS the current selection — the play button and the
  // pane restore must never act on a stale flight (a selection whose
  // track never arrives would otherwise replay its predecessor).
  const available = replayAvailable(held?.flight ?? null, held?.track ?? []);
  const availableNow =
    flight !== null && held?.flight.id === flight.id ? available : false;

  // Fold with a hidden host; return with it when the pane is wanted (all
  // render-adjusted — guarded, converging — never in an effect). The
  // return is static: already 1fr, no slide, paused.
  if (!enabled) {
    if (session.phase !== "closed") {
      setSession({
        phase: "closed",
        autoplayFor: null,
        mode: "replay",
        resume: null,
      });
    }
    if (active) setActive(false);
    if (camera.follow || camera.trackUp) {
      setCamera({ follow: false, trackUp: false });
    }
  } else if (session.phase !== "closed" && !available) {
    // The drawer element only renders while available: if availability
    // dies mid-phase (a switch onto a too-short flight during the close
    // slide), transitionend can never fire — force the phase down or it
    // strands at "closing"/"open" with every control gone.
    setSession({
      phase: "closed",
      autoplayFor: null,
      mode: "replay",
      resume: null,
    });
    if (active) setActive(false);
  } else if (session.phase === "closed" && paneWanted() && availableNow) {
    setSession({
      phase: "open",
      autoplayFor: null,
      mode: "replay",
      resume: null,
    });
  }

  // Mounted collapsed (0fr), an explicit open slides on the NEXT frame so
  // the grid-rows transition actually runs.
  useEffect(() => {
    if (session.phase !== "opening") return;
    return afterNextFrame(() =>
      setSession((prior) =>
        prior.phase === "opening" ? { ...prior, phase: "open" } : prior,
      ),
    );
  }, [session.phase]);

  function open() {
    setCamera({ follow: false, trackUp: false });
    setActive(true); // the play button opens PLAYING — glyph on the map
    rememberPane(true);
    setSession({
      phase: "opening",
      autoplayFor: held?.flight.id ?? flight?.id ?? null,
      mode: "replay",
      resume: null,
    });
  }

  // The options sheet's trim/split entries: open (or repurpose) the pane
  // as a clip editor. Deliberately NOT remembered as a wanted pane — a
  // clip is an errand, not a workspace choice. The player state is
  // stashed so exit restores it; hopping straight between editors keeps
  // the FIRST stash (the player as the pilot last saw it).
  function beginClip(mode: ClipMode) {
    setSession((prior) => ({
      phase: prior.phase === "closed" ? "opening" : prior.phase,
      autoplayFor: null,
      mode,
      resume: prior.mode === "replay" ? { active, camera } : prior.resume,
    }));
    setCamera({ follow: false, trackUp: false });
    setActive(false);
  }

  // Exit a clip editor (cancel or applied) back into the player it
  // borrowed: same position and zoom (timelineMemory), same glyph and
  // camera modes (the stash).
  function endClip() {
    const resume = session.resume;
    if (resume) {
      setActive(resume.active);
      setCamera(resume.camera);
    }
    setSession((prior) => ({ ...prior, mode: "replay", resume: null }));
  }

  // Persist a clip at the chosen cut point. The dock stays mounted (busy)
  // until this resolves, so a storage failure is visible — the editor
  // simply remains, unapplied.
  async function applyClip(cut: number) {
    if (!held) return;
    // Timeline continuity: the replay that follows lands at the cut
    // (clamped into the rewritten track by the feed).
    rememberPosition(held.flight.id, cut);
    if (session.mode === "trim-start" || session.mode === "trim-end") {
      const kept =
        session.mode === "trim-start"
          ? sliceTrack(
              held.track,
              cut,
              held.track[held.track.length - 1].timestamp,
            )
          : sliceTrack(held.track, held.track[0].timestamp, cut);
      await rewriteFlightTrack(held.flight.id, kept, computeStats(kept));
    } else {
      const { first, second } = splitTrack(held.track, cut);
      const at: LngLat = [second[0].longitude, second[0].latitude];
      const source = held.flight;
      const launchName = await inheritedLaunchName(at);
      // The second half becomes a NEW flight, written FIRST so a failure
      // between the two writes leaves DUPLICATE data (both flights still
      // hold the tail), never lost data — the loss-safe order.
      //
      // Its id is DETERMINISTIC (the repo's recorded-<startedAt>
      // convention, and the second half's startedAt IS second[0]) and the
      // create tolerates a conflict: if the source rewrite below fails and
      // the pilot retries, the retry re-targets the SAME second-half doc
      // (saveFlight's track put is already 409-idempotent; this tolerates
      // the flight-doc conflict too) instead of minting ANOTHER
      // fresh-uuid duplicate every attempt. The split is idempotent. The
      // original keeps its id and startedAt.
      try {
        await saveFlight(
          {
            id: `recorded-${second[0].timestamp}`,
            name: source.name,
            notes: "",
            startedAt: second[0].timestamp,
            stats: computeStats(second),
            updatedAt: Date.now(),
            source: source.source,
            sourceFilename: source.sourceFilename,
            importBatchId: source.importBatchId,
            importedAt: source.importedAt,
            launchAt: at,
            // The pilot's own site register names the new launch; the
            // spot usually matches the original flight's field.
            launchName,
          },
          second,
        );
      } catch (error) {
        // A retry of a half-applied split: the second-half flight already
        // exists (identical bytes). Only a genuine conflict is tolerated.
        if ((error as { name?: string }).name !== "conflict") throw error;
      }
      await rewriteFlightTrack(source.id, first, computeStats(first));
    }
    endClip();
  }

  // Parking clears the camera modes with the glyph: stop is a full reset.
  function changeActive(next: boolean) {
    setActive(next);
    if (!next) setCamera({ follow: false, trackUp: false });
  }

  function collapse() {
    changeActive(false);
    rememberPane(false);
    // Without a transition there is no transitionend to finish the close.
    setSession((prior) => ({
      ...prior,
      phase: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "closed"
        : "closing",
    }));
  }

  const isOpen = session.phase !== "closed";

  function toggleHideAhead() {
    const next = !hideAhead;
    rememberHideAhead(next);
    setHideAhead(next);
  }

  return {
    available: availableNow,
    isOpen,
    trackHidden: isOpen && ((active && hideAhead) || session.mode !== "replay"),
    open,
    beginClip,
    playButton:
      availableNow && enabled && !isOpen ? (
        <button
          className={mapCss.button}
          aria-label="Replay flight"
          data-testid="replay-start"
          onClick={open}
        >
          <NativeIcon icon={play} />
        </button>
      ) : null,
    followButton:
      isOpen && active ? (
        <button
          className={mapCss.button}
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
      ) : null,
    trackUpButton:
      isOpen && active ? (
        <button
          className={mapCss.button}
          aria-label={
            camera.follow && camera.trackUp ? "Align north" : "Track up"
          }
          data-active={camera.follow && camera.trackUp}
          data-testid="replay-trackup"
          onClick={() =>
            // One tap arms the full in-flight view (follow + track-up) —
            // unlike the fly page, follow defaults OFF here, and the
            // two-press ritual read as "the compass is broken". Tapping
            // again drops track-up (the next render re-norths).
            setCamera((prior) =>
              prior.follow
                ? { ...prior, trackUp: !prior.trackUp }
                : { follow: true, trackUp: true },
            )
          }
        >
          <NativeIcon icon={compassOutline} />
        </button>
      ) : null,
    drawer:
      available && held && isOpen ? (
        <div
          className={
            session.phase === "open"
              ? `${styles.drawer} ${styles.open}`
              : styles.drawer
          }
          onTransitionEnd={(event) => {
            if (
              session.phase === "closing" &&
              event.propertyName === "grid-template-rows"
            ) {
              setSession((prior) => ({ ...prior, phase: "closed" }));
            }
          }}
        >
          {/* The drawer pull, straddling the pane's top edge: stop and
              slide the whole pane away. The bump silhouette is ONE svg
              path of cubic Béziers — a single S-curve per side with
              horizontal tangents at the edge and the apex, so curvature
              varies CONTINUOUSLY (tangent circular arcs are only G1: the
              curvature steps at every junction read as kinks). */}
          <button
            className={styles.tab}
            aria-label="Hide replay"
            data-testid="replay-collapse"
            onClick={collapse}
          >
            <svg className={styles.bump} viewBox="0 0 72 20" aria-hidden="true">
              {/* The curve's tangent BASELINE (y=21) sits exactly ON the
                  pane edge (anchoring it lower was the source of every
                  junction artifact); the rect skirt below (y=21..22)
                  guards the seam, and one unit of apex headroom keeps
                  the antialiasing unclipped. Meaty and sweepy: a wide
                  (72-unit) profile, fat 14-unit dome cap, 45-degree
                  mid-height waists ((20,10)/(52,10)), and long 10-unit
                  base arms trailing the fillet into the pane. */}
              <path d="M0 20 L0 19 L2 19 C12 19 15 15 20 10 C25 5 29 1 36 1 C43 1 47 5 52 10 C57 15 60 19 70 19 L72 19 L72 20 Z" />
            </svg>
            <NativeIcon icon={chevronDownOutline} />
          </button>
          <div className={styles.clip}>
            {/* Keys carry the track's span: a clip rewriting the track
                under the open pane remounts the dock against the new
                recording (the feed/handles bind their track at mount). */}
            {session.mode !== "replay" ? (
              <ClipDock
                key={`${session.mode}:${held.flight.id}:${held.track[0].timestamp}:${held.track[held.track.length - 1].timestamp}`}
                mode={session.mode}
                map={map}
                track={held.track}
                timelineKey={held.flight.id}
                onCancel={endClip}
                onApply={applyClip}
                seat={seat}
              />
            ) : (
              <ReplayDock
                key={`${held.flight.id}:${held.track[0].timestamp}:${held.track[held.track.length - 1].timestamp}`}
                map={map}
                track={held.track}
                timelineKey={held.flight.id}
                autoplay={session.autoplayFor === held.flight.id}
                camera={camera}
                onFollowBroken={() =>
                  setCamera({ follow: false, trackUp: false })
                }
                active={active}
                onActiveChange={changeActive}
                hideAhead={hideAhead}
                onToggleHideAhead={toggleHideAhead}
                onCollapse={collapse}
                seat={seat}
              />
            )}
          </div>
        </div>
      ) : null,
  };
}
