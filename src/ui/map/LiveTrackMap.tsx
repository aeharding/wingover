import { useEffect, useEffectEvent, useRef, useState } from "react";

import type { Fix } from "../../engine/types";
import type { MapViewKind } from "./config";
import { readLiveViewState, writeLiveViewState } from "./liveViewState";
import MapCanvas from "./MapCanvas";
import {
  type Aircraft,
  type GestureEvent,
  type Insets,
  type Line,
  type LngLat,
  type MapView,
  TRACK_LINE_WIDTH_PX,
} from "./types";
import ZoomControl from "./ZoomControl";

import "./LiveTrackMap.css";

// Snapped, event-driven playback. There is no rAF loop: the map updates once
// per fix (~1 Hz), so the basemap repaints ~1×/s instead of ~60×/s — the
// dominant in-flight battery cost — for a step that at flight zoom is a pixel
// or two. The only animations left are rotations, and they're delegated to
// the backend (a native camera turn, a CSS transform on the glyph) rather
// than interpolated frame-by-frame in JS.
const WHEEL_ZOOM_RATE = 1 / 450;
const PINCH_ZOOM_RATE = 1 / 100;

interface LiveTrackMapProps {
  track: Fix[];
  latest: Fix | null;
  view: MapViewKind;
  follow: boolean;
  trackUp: boolean;
  topInset?: number;
  onFollowChange: (follow: boolean) => void;
}

export default function LiveTrackMap({
  track,
  latest,
  view,
  follow,
  trackUp,
  topInset = 0,
  onFollowChange,
}: LiveTrackMapProps) {
  const [map, setMap] = useState<MapView | null>(null);
  // Content handles into the abstract map. The committed flown line is a
  // normal Line; the aircraft + its uncommitted tail is the intent-based
  // aircraft() overlay the backend renders however it can.
  const trackLineRef = useRef<Line | null>(null);
  const aircraftRef = useRef<Aircraft | null>(null);
  const positionInitializedRef = useRef(false);
  const interactingRef = useRef(false);

  // Only the real top-panel offset now (keeps the aircraft below the header
  // overlay). The map container is exactly viewport-sized — no overscan.
  function cameraPadding(): Insets {
    return { top: topInset, bottom: 0, left: 0, right: 0 };
  }

  // Draw the current state: the aircraft snaps to the newest fix and, while
  // following, the camera jumps to it. The flown line is the whole track, set
  // once per fix — at ~1 Hz there's no need to split it into a throttled
  // committed line plus an uncommitted tail. Rotation (the track-up camera
  // turn and the heading glyph) is animated by the backend, not here. An
  // Effect Event so it always sees the latest props.
  const renderNow = useEffectEvent(() => {
    if (!map) return;
    const fixes = track;
    if (fixes.length === 0) return;
    const newest = fixes[fixes.length - 1];
    const at: LngLat = [newest.longitude, newest.latitude];

    trackLineRef.current?.set(
      fixes.map((fix): LngLat => [fix.longitude, fix.latitude]),
    );

    // Center and bearing both jump — a native rotation *animation* is what
    // makes the flown-line overlay wiggle (the base map tweens smoothly, but
    // MapKit re-renders the polyline a beat behind the animated transform).
    // Snapping keeps map, path and glyph locked together.
    if (follow && !interactingRef.current) {
      map.moveTo(
        {
          center: at,
          bearing: trackUp ? newest.course : 0,
          padding: cameraPadding(),
        },
        { animate: false },
      );
    }

    aircraftRef.current?.set({ at, heading: newest.course });
  });

  const handleDragStart = useEffectEvent(() => {
    onFollowChange(false);
  });

  // While following, intercept the wheel and apply the zoom directly and
  // instantly (the finger/wheel IS the animation). The map is centered on the
  // aircraft, so the zoom anchors there. Unpinned keeps native behavior.
  const handleWheel = useEffectEvent((event: GestureEvent) => {
    if (!map) return;
    if (!follow || interactingRef.current) return;
    event.preventDefault?.();
    const rate = event.ctrlKey ? PINCH_ZOOM_RATE : WHEEL_ZOOM_RATE;
    const { min, max } = map.zoomRange();
    const from = map.camera().zoom;
    const next = Math.min(max, Math.max(min, from - (event.deltaY ?? 0) * rate));
    map.moveTo({ zoom: next }, { animate: false });
  });

  const setupMap = useEffectEvent((mapView: MapView) => {
    trackLineRef.current = mapView.line({
      color: "#4cc2ff",
      width: TRACK_LINE_WIDTH_PX,
      testId: "track",
    });
    aircraftRef.current = mapView.aircraft();

    mapView.lockZoomAnchor(follow ? "center" : null);
    mapView.on("down", () => {
      interactingRef.current = true;
    });
    mapView.on("up", () => {
      interactingRef.current = false;
    });
    mapView.on("dragend", (event) => {
      interactingRef.current = false;
      writeLiveViewState({ center: event.at });
    });
    mapView.on("dragstart", () => handleDragStart());
    mapView.on("wheel", (event) => handleWheel(event));
    mapView.on("zoomend", () => {
      writeLiveViewState({ zoom: mapView.camera().zoom });
    });

    const last = track[track.length - 1];
    if (last) {
      positionInitializedRef.current = true;
      const saved = readLiveViewState();
      const center: LngLat =
        !follow && saved.center
          ? saved.center
          : [last.longitude, last.latitude];
      mapView.moveTo(
        {
          center,
          zoom: saved.zoom ?? 13,
          bearing: trackUp ? last.course : 0,
          padding: cameraPadding(),
        },
        { animate: false },
      );
      renderNow();
    }
  });

  useEffect(() => {
    if (map) setupMap(map);
  }, [map]);

  const handleNewFix = useEffectEvent((fix: Fix) => {
    if (!map) return;
    if (!positionInitializedRef.current) {
      positionInitializedRef.current = true;
      map.moveTo(
        {
          center: [fix.longitude, fix.latitude],
          zoom: readLiveViewState().zoom ?? 13,
          bearing: trackUp ? fix.course : 0,
          padding: cameraPadding(),
        },
        { animate: false },
      );
    }
    renderNow();
  });

  useEffect(() => {
    if (latest) handleNewFix(latest);
  }, [latest]);

  const applyFollowChange = useEffectEvent((following: boolean) => {
    if (!map) return;
    map.lockZoomAnchor(following ? "center" : null);
    const newest = track[track.length - 1];
    if (!following || !newest) return;
    map.moveTo(
      {
        center: [newest.longitude, newest.latitude],
        zoom: Math.max(map.camera().zoom, 11),
        bearing: trackUp ? newest.course : 0,
        padding: cameraPadding(),
      },
      { animate: false },
    );
  });

  useEffect(() => {
    applyFollowChange(follow);
  }, [follow]);

  // Zoom-control input jumps the map directly — no React state per move
  // (this fires at pointer rate), no smoothing (the finger IS the animation).
  function applyZoom(zoom: number) {
    if (!map) return;
    map.moveTo({ zoom }, { animate: false });
  }

  const applyTrackUpChange = useEffectEvent(() => {
    if (!map) return;
    if (follow) {
      // Re-render at the current fix: the camera snaps to the new orientation
      // and the glyph follows.
      renderNow();
      return;
    }
    const newest = track[track.length - 1];
    const bearing = trackUp ? (newest?.course ?? 0) : 0;
    map.moveTo({ bearing }, { animate: true });
  });

  useEffect(() => {
    applyTrackUpChange();
  }, [trackUp]);

  return (
    <div className="live-map">
      <MapCanvas base={view} onReady={setMap} />
      {map && <ZoomControl map={map} onInput={applyZoom} />}
      {/* Inert guard along the bottom edge — the iOS app-switch swipe
          (home indicator). A touch that starts here targets the guard,
          not the map's canvas, so the map cannot pan while iOS decides
          the edge swipe; the OS gesture, being system-level, still fires. */}
      <div className="map-edge-guard map-edge-guard-bottom" aria-hidden="true" />
    </div>
  );
}
