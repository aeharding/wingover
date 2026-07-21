import { useEffect, useEffectEvent, useRef } from "react";

import type { Fix } from "../../engine/types";
import { applyFollowWheelZoom } from "../map/followZoom";
import type { Aircraft, GestureEvent, LngLat, MapView } from "../map/types";

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
  camera: ReplayCamera,
  onFollowBroken: () => void,
) {
  const aircraftRef = useRef<Aircraft | null>(null);
  const interactingRef = useRef(false);

  const render = useEffectEvent(() => {
    if (!latest) return;
    const at: LngLat = [latest.longitude, latest.latitude];
    aircraftRef.current?.set({ at, heading: latest.course });
    // Snapped, never animated, exactly like the live map: an animated
    // camera tweens the basemap while the track overlay re-renders a beat
    // behind it, and the path visibly wiggles.
    if (map && camera.follow && !interactingRef.current) {
      map.moveTo(
        { center: at, bearing: camera.trackUp ? latest.course : 0 },
        { animate: false },
      );
    }
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

  useEffect(() => {
    if (!map) return;
    const aircraft = map.aircraft();
    aircraftRef.current = aircraft;
    const offDown = map.on("down", () => {
      interactingRef.current = true;
    });
    const offUp = map.on("up", () => {
      interactingRef.current = false;
    });
    const offDrag = map.on("dragstart", () => breakFollow());
    const offWheel = map.on("wheel", (event) => handleWheel(event));
    render();
    return () => {
      offDown();
      offUp();
      offDrag();
      offWheel();
      aircraftRef.current = null;
      // A provider swap destroys the view before the null onReady lands
      // here; cleaning handles on a dead view must not throw the app.
      try {
        map.lockZoomAnchor(null);
        aircraft.remove();
      } catch {
        // nothing left to clean on a destroyed view
      }
    };
  }, [map]);

  useEffect(() => {
    render();
  }, [latest]);

  // Engaging follow snaps to the aircraft and pins pinch/scroll zoom to
  // it (the LiveTrackMap pattern); disengaging restores cursor anchor.
  const applyCamera = useEffectEvent(() => {
    if (!map) return;
    map.lockZoomAnchor(camera.follow ? "center" : null);
    if (camera.follow) render();
  });

  useEffect(() => {
    applyCamera();
  }, [camera.follow, camera.trackUp, map]);
}
