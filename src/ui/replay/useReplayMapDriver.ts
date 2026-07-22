import { useEffect, useEffectEvent, useRef } from "react";

import type { Fix } from "../../engine/types";
import { applyFollowWheelZoom } from "../map/followZoom";
import {
  ACCENT_CYAN,
  type Aircraft,
  type GestureEvent,
  type Line,
  type LngLat,
  type MapView,
  TRACK_LINE_WIDTH_PX,
} from "../map/types";

export interface ReplayCamera {
  follow: boolean;
  trackUp: boolean;
}

/**
 * Drives the HOST map from the replay feed: the aircraft glyph that flies
 * the already-drawn track, plus the optional fly-page camera modes —
 * while following, the camera snaps to each fix (track-up rotates with
 * the course), a drag breaks follow, and zoom anchors on the aircraft.
 * The host's track line and markers stay exactly as the host renders
 * them.
 */
export function useReplayMapDriver(
  map: MapView | null,
  latest: Fix | null,
  // Non-null = the "hide the path ahead" mode: the host blanks its full
  // track line (see the hosts' trackHidden gate) and this line draws
  // only the FLOWN prefix, so the route reveals itself as the aircraft
  // flies it. Null = mode off, the driver's line stays empty.
  flown: Fix[] | null,
  camera: ReplayCamera,
  onFollowBroken: () => void,
) {
  const aircraftRef = useRef<Aircraft | null>(null);
  const flownLineRef = useRef<Line | null>(null);
  const interactingRef = useRef(false);

  const render = useEffectEvent(() => {
    // null = replay is parked (stopped): the glyph leaves the map.
    if (!latest) {
      aircraftRef.current?.set(null);
      return;
    }
    const at: LngLat = [latest.longitude, latest.latitude];
    // Snapped, never animated, exactly like the live map: an animated
    // camera tweens the basemap while the track overlay re-renders a beat
    // behind it, and the path visibly wiggles.
    if (map && camera.follow && !interactingRef.current) {
      map.moveTo(
        { center: at, bearing: camera.trackUp ? latest.course : 0 },
        { animate: false },
      );
    }
    // AFTER the camera move, never before: MapKit orients the glyph
    // against the bearing the app LAST asked for, so a set() ahead of the
    // track-up moveTo leaves the chevron pointing at the old north — the
    // map rotates and the aircraft visibly doesn't (LiveTrackMap orders
    // the same way).
    aircraftRef.current?.set({ at, heading: latest.course });
  });

  const breakFollow = useEffectEvent(() => {
    if (camera.follow) onFollowBroken();
  });

  // While following, the wheel becomes a pure aircraft-anchored zoom —
  // the exact fly-page behavior, shared via followZoom.ts.
  const handleWheel = useEffectEvent((event: GestureEvent) => {
    if (!map) return;
    if (!camera.follow || interactingRef.current) return;
    applyFollowWheelZoom(map, event);
  });

  const drawFlown = useEffectEvent(() => {
    flownLineRef.current?.set(
      flown ? flown.map((fix): LngLat => [fix.longitude, fix.latitude]) : [],
    );
  });

  useEffect(() => {
    if (!map) return;
    const aircraft = map.aircraft();
    aircraftRef.current = aircraft;
    // Created after the host's lines, so the flown prefix draws on top.
    const flownLine = map.line({
      color: ACCENT_CYAN,
      width: TRACK_LINE_WIDTH_PX,
      testId: "replay-flown",
    });
    flownLineRef.current = flownLine;
    const offDown = map.on("down", () => {
      interactingRef.current = true;
    });
    const offUp = map.on("up", () => {
      interactingRef.current = false;
    });
    const offDrag = map.on("dragstart", () => breakFollow());
    const offWheel = map.on("wheel", (event) => handleWheel(event));
    render();
    drawFlown();
    return () => {
      offDown();
      offUp();
      offDrag();
      offWheel();
      aircraftRef.current = null;
      flownLineRef.current = null;
      // A provider swap destroys the view before the null onReady lands
      // here; cleaning handles on a dead view must not throw the app.
      try {
        map.lockZoomAnchor(null);
        aircraft.remove();
        flownLine.remove();
      } catch {
        // nothing left to clean on a destroyed view
      }
    };
  }, [map]);

  useEffect(() => {
    render();
  }, [latest]);

  useEffect(() => {
    drawFlown();
  }, [flown]);

  // Engaging follow snaps to the aircraft and pins pinch/scroll zoom to
  // it (the LiveTrackMap pattern); disengaging restores cursor anchor.
  // No subject, no camera: a PARKED replay (latest null, glyph off the
  // map) must never lock the zoom anchor to nothing.
  const applyCamera = useEffectEvent(() => {
    if (!map) return;
    const engaged = camera.follow && latest !== null;
    map.lockZoomAnchor(engaged ? "center" : null);
    if (engaged) render();
  });

  const parked = latest === null;

  useEffect(() => {
    applyCamera();
  }, [camera.follow, camera.trackUp, map, parked]);
}
