import type { Feature } from "geojson";
import type {
  CustomLayerInterface,
  GeoJSONSource,
  Map as MapLibreMap,
  MapWheelEvent,
} from "maplibre-gl";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import type { Fix } from "../../engine/types";
import { relativeBearing } from "../../flight/nav";
import type { MapViewKind } from "./config";
import { readLiveViewState, writeLiveViewState } from "./liveViewState";
import MapView, { type MapLibreModule } from "./MapView";

import "./LiveTrackMap.css";

// Playback runs a fixed lag behind the newest fix as piecewise-linear legs
// at constant velocity — proportional chasing surges after every fix and
// crawls before the next, which reads as 1 Hz speed pulsing.
const SNAP_LAG_REAL_MS = 2500;
const FIX_INTERVAL_MIN_MS = 30;
const FIX_INTERVAL_MAX_MS = 3000;
const FIX_INTERVAL_EMA_ALPHA = 0.2;
// When frames stall and a backlog builds, clear it at a bounded overspeed
// instead of compressing it into one leg (reads as a teleport).
const MAX_CATCHUP_RATE = 1.5;
// Legs run slightly longer than the expected interval so ordinary arrival
// jitter starts the next leg before this one starves (a paused playhead
// reads as motion stutter); the cost is a fraction of a fix of extra lag.
const LEG_DURATION_PAD = 1.15;
const COURSE_SMOOTH_MS = 400;
// Continuous track-up chase only — a track-up TOGGLE rotates over a
// short fixed duration instead: fast enough to be functional, long
// enough that the eye can track where north went.
const BEARING_SMOOTH_MS = 400;
const ALIGN_ROTATE_MS = 200;
const ZOOM_SMOOTH_MS = 200;
const WHEEL_ZOOM_RATE = 1 / 450;
const PINCH_ZOOM_RATE = 1 / 100;
const OVERSCAN_PX = 256;
const ARROW_PX = 30;
const LINE_WIDTH_PX = 4;
const TAIL_MAX_POINTS = 1000;
const JOINT_SEGMENTS = 8;
const COMMIT_INTERVAL_MS = 2000;

interface LiveTrackMapProps {
  track: Fix[];
  latest: Fix | null;
  view: MapViewKind;
  follow: boolean;
  trackUp: boolean;
  topInset?: number;
  onFollowChange: (follow: boolean) => void;
}

interface DisplayPosition {
  lng: number;
  lat: number;
  course: number;
}

function normalizeDeg(degrees: number) {
  return ((degrees % 360) + 360) % 360;
}

function toLineData(coordinates: [number, number][]): Feature {
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates },
  };
}

const ARROW_SHAPE: [number, number][] = [
  [0, -10],
  [7, 8],
  [0, 4],
  [0, -10],
  [0, 4],
  [-7, 8],
];

const VERTEX_SHADER = `
attribute vec2 a_pos;
uniform mat4 u_matrix;
void main() {
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `
precision mediump float;
uniform vec4 u_color;
void main() {
  gl_FragColor = u_color;
}`;

const FILL_COLOR = [0.298, 0.761, 1.0, 1.0];
const OUTLINE_COLOR = [0.043, 0.133, 0.188, 1.0];

interface AircraftFrame {
  display: DisplayPosition;
  tail: [number, number][];
}

function pushTailVertices(
  vertices: number[],
  points: number[],
  halfWidth: number,
) {
  for (let i = 0; i + 3 < points.length; i += 2) {
    const ax = points[i];
    const ay = points[i + 1];
    const bx = points[i + 2];
    const by = points[i + 3];
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.hypot(dx, dy);
    if (length === 0) continue;
    const nx = (-dy / length) * halfWidth;
    const ny = (dx / length) * halfWidth;
    vertices.push(
      ax + nx,
      ay + ny,
      ax - nx,
      ay - ny,
      bx + nx,
      by + ny,
      bx + nx,
      by + ny,
      ax - nx,
      ay - ny,
      bx - nx,
      by - ny,
    );
  }
  for (let i = 2; i < points.length; i += 2) {
    const cx = points[i];
    const cy = points[i + 1];
    for (let s = 0; s < JOINT_SEGMENTS; s++) {
      const a0 = (s / JOINT_SEGMENTS) * 2 * Math.PI;
      const a1 = ((s + 1) / JOINT_SEGMENTS) * 2 * Math.PI;
      vertices.push(
        cx,
        cy,
        cx + Math.cos(a0) * halfWidth,
        cy + Math.sin(a0) * halfWidth,
        cx + Math.cos(a1) * halfWidth,
        cy + Math.sin(a1) * halfWidth,
      );
    }
  }
}

function createAircraftLayer(
  lib: MapLibreModule,
  getFrame: () => AircraftFrame | null,
): CustomLayerInterface {
  let map: MapLibreMap;
  let program: WebGLProgram | null = null;
  let buffer: WebGLBuffer;
  let aPos: number;
  let uMatrix: WebGLUniformLocation;
  let uColor: WebGLUniformLocation;

  return {
    id: "aircraft",
    type: "custom",
    renderingMode: "2d",

    onAdd(addedMap, gl) {
      map = addedMap;
      const vertex = gl.createShader(gl.VERTEX_SHADER)!;
      gl.shaderSource(vertex, VERTEX_SHADER);
      gl.compileShader(vertex);
      const fragment = gl.createShader(gl.FRAGMENT_SHADER)!;
      gl.shaderSource(fragment, FRAGMENT_SHADER);
      gl.compileShader(fragment);
      program = gl.createProgram()!;
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      aPos = gl.getAttribLocation(program, "a_pos");
      uMatrix = gl.getUniformLocation(program, "u_matrix")!;
      uColor = gl.getUniformLocation(program, "u_color")!;
      buffer = gl.createBuffer()!;
    },

    render(gl, args) {
      const frame = getFrame();
      if (!frame || !program) return;
      const { display, tail } = frame;

      const projection = args as unknown as {
        defaultProjectionData?: { mainMatrix: number[] | Float32Array };
      };
      const matrix =
        projection?.defaultProjectionData?.mainMatrix ??
        (args as unknown as Float32Array);

      const anchor = lib.MercatorCoordinate.fromLngLat([
        display.lng,
        display.lat,
      ]);
      const worldSize = 512 * Math.pow(2, map.getZoom());
      const unitsPerPixel = 1 / worldSize;

      // Vertices are anchor-relative so Float32 stays precise at high zoom;
      // the anchor translation folds into the matrix in double precision.
      const translated = new Array<number>(16);
      for (let i = 0; i < 12; i++) translated[i] = matrix[i];
      for (let i = 0; i < 4; i++) {
        translated[12 + i] =
          matrix[i] * anchor.x + matrix[4 + i] * anchor.y + matrix[12 + i];
      }

      const points: number[] = [];
      for (const [lng, lat] of tail) {
        const merc = lib.MercatorCoordinate.fromLngLat([lng, lat]);
        points.push(merc.x - anchor.x, merc.y - anchor.y);
      }
      points.push(0, 0);

      const vertices: number[] = [];
      pushTailVertices(vertices, points, (LINE_WIDTH_PX / 2) * unitsPerPixel);
      const tailVertexCount = vertices.length / 2;

      const unitsPerArrowUnit = ARROW_PX / 24 / worldSize;
      const radians = (display.course * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      for (let pass = 0; pass < 2; pass++) {
        const scale = unitsPerArrowUnit * (pass === 0 ? 1.25 : 1);
        for (const [lx, ly] of ARROW_SHAPE) {
          vertices.push(
            (lx * cos - ly * sin) * scale,
            (lx * sin + ly * cos) * scale,
          );
        }
      }

      gl.useProgram(program);
      gl.uniformMatrix4fv(uMatrix, false, new Float32Array(translated));
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array(vertices),
        gl.DYNAMIC_DRAW,
      );
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform4fv(uColor, FILL_COLOR);
      gl.drawArrays(gl.TRIANGLES, 0, tailVertexCount);
      gl.uniform4fv(uColor, OUTLINE_COLOR);
      gl.drawArrays(gl.TRIANGLES, tailVertexCount, ARROW_SHAPE.length);
      gl.uniform4fv(uColor, FILL_COLOR);
      gl.drawArrays(
        gl.TRIANGLES,
        tailVertexCount + ARROW_SHAPE.length,
        ARROW_SHAPE.length,
      );
    },
  };
}

interface MapContext {
  map: MapLibreMap;
  lib: MapLibreModule;
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
  const [mapContext, setMapContext] = useState<MapContext | null>(null);
  const positionInitializedRef = useRef(false);
  const interactingRef = useRef(false);
  const displayRef = useRef<DisplayPosition | null>(null);
  const lineCoordsRef = useRef<[number, number][]>([]);
  // Timestamp of the last fix consumed into lineCoords — detects a track
  // prop whose history changed out from under the incremental append.
  const lineEndTsRef = useRef<number | null>(null);
  const committedCountRef = useRef(0);
  const pendingCountRef = useRef<number | null>(null);
  const confirmArmedRef = useRef(false);
  const lastCommitAtRef = useRef(0);
  const playheadRef = useRef<{ ts: number; index: number } | null>(null);
  const smoothedCourseRef = useRef<number | null>(null);
  const cameraBearingRef = useRef<number | null>(null);
  // A toggle-triggered alignment: constant-progress rotation to the
  // bearing target over ALIGN_ROTATE_MS, then back to the normal chase.
  const bearingAlignRef = useRef<{ from: number; startedAt: number } | null>(
    null,
  );
  // Playback leg: advance the playhead toward toTs at a fixed track-time
  // rate per real ms. Rate-based (not wall-clock) so starved frames advance
  // proportionally instead of stalling and teleporting.
  const legRef = useRef<{ toTs: number; rate: number } | null>(null);
  const fixIntervalEmaRef = useRef(1000);
  // Track-time production rate (timestamp ms per real ms): 1 at live speed,
  // the compression factor under the mock.
  const trackRateEmaRef = useRef(1);
  const lastFixArrivalRef = useRef<number | null>(null);
  const lastFixTsRef = useRef<number | null>(null);
  const zoomTargetRef = useRef<number | null>(null);
  const loopFrameRef = useRef<number | undefined>(undefined);
  const lastStepAtRef = useRef(0);

  function cameraPadding() {
    return {
      top: OVERSCAN_PX + topInset,
      bottom: OVERSCAN_PX,
      left: OVERSCAN_PX,
      right: OVERSCAN_PX,
    };
  }

  // While following, zoom gestures anchor at the (padded) center where the
  // aircraft sits, so pinch/scroll never tugs it toward the cursor. Unpinned
  // zoom anchors at the cursor as usual.
  function applyZoomAnchor(map: MapLibreMap, following: boolean) {
    const options = following ? { around: "center" as const } : undefined;
    map.scrollZoom.enable(options);
    map.touchZoomRotate.enable(options);
  }

  // The line only ever contains fixes the playhead has passed, so it can
  // never extend ahead of the aircraft.
  function syncLine(map: MapLibreMap) {
    const fixes = track;
    const playhead = playheadRef.current;
    const upTo = playhead ? Math.min(playhead.index + 1, fixes.length) : 0;
    // EngineSnapshot.track is append-only within a session (its documented
    // contract); this enforces it. If the consumed prefix ever stops lining
    // up, appending would mix coordinates from two indexings into one
    // permanently wrong line — rebuild instead.
    const consumed = lineCoordsRef.current.length;
    const intact =
      consumed <= upTo &&
      (consumed === 0 ||
        fixes[consumed - 1].timestamp === lineEndTsRef.current);
    if (!intact) {
      lineCoordsRef.current = [];
      lineEndTsRef.current = null;
      committedCountRef.current = 0;
      pendingCountRef.current = null;
      confirmArmedRef.current = false;
      const source = map.getSource("track") as GeoJSONSource | undefined;
      source?.setData(toLineData([]));
    }
    while (lineCoordsRef.current.length < upTo) {
      const fix = fixes[lineCoordsRef.current.length];
      lineCoordsRef.current.push([fix.longitude, fix.latitude]);
      lineEndTsRef.current = fix.timestamp;
    }
    maybeCommitLine(map);
  }

  // The committed line only re-uploads once the worker confirmed the previous
  // upload; the custom layer draws the uncommitted tail synchronously.
  function maybeCommitLine(map: MapLibreMap) {
    if (pendingCountRef.current !== null) return;
    const coords = lineCoordsRef.current;
    if (committedCountRef.current >= coords.length) return;
    const now = performance.now();
    if (
      committedCountRef.current > 0 &&
      now - lastCommitAtRef.current < COMMIT_INTERVAL_MS
    ) {
      return;
    }
    const source = map.getSource("track") as GeoJSONSource | undefined;
    if (!source) return;
    lastCommitAtRef.current = now;
    pendingCountRef.current = coords.length;
    source.setData(toLineData(coords));
  }

  function advanceCommit(map: MapLibreMap) {
    if (
      pendingCountRef.current === null ||
      !map.getSource("track") ||
      !map.isSourceLoaded("track")
    ) {
      confirmArmedRef.current = false;
      return;
    }
    if (!confirmArmedRef.current) {
      confirmArmedRef.current = true;
      return;
    }
    committedCountRef.current = pendingCountRef.current;
    pendingCountRef.current = null;
    confirmArmedRef.current = false;
    maybeCommitLine(map);
  }

  function getAircraftFrame(map: MapLibreMap): AircraftFrame | null {
    advanceCommit(map);
    const display = displayRef.current;
    if (!display) return null;
    const coords = lineCoordsRef.current;
    const seam = Math.max(0, committedCountRef.current - 1);
    const tail = coords.slice(Math.max(seam, coords.length - TAIL_MAX_POINTS));
    (
      map.getContainer() as HTMLElement & {
        __tail?: {
          committed: number;
          total: number;
          tailCoords: [number, number][];
          playheadTs: number | null;
        };
      }
    ).__tail = {
      committed: committedCountRef.current,
      total: coords.length,
      tailCoords: tail,
      playheadTs: playheadRef.current?.ts ?? null,
    };
    return { display, tail };
  }

  function renderFrame(
    map: MapLibreMap,
    position: DisplayPosition,
    zoom?: number,
  ) {
    displayRef.current = position;

    (
      map.getContainer() as HTMLElement & { __display?: DisplayPosition }
    ).__display = position;

    if (follow && !interactingRef.current) {
      map.jumpTo({
        center: [position.lng, position.lat],
        bearing: cameraBearingRef.current ?? (trackUp ? position.course : 0),
        padding: cameraPadding(),
        ...(zoom !== undefined && { zoom }),
      });
    } else {
      map.triggerRepaint();
    }
  }

  // The playhead travels along the recorded track polyline at constant
  // velocity per leg, one learned fix-interval behind live. Both the
  // aircraft and the line derive from it, so they cannot diverge.
  // An Effect Event so the rAF callback always sees the latest props.
  const stepPlayhead = useEffectEvent((now: number) => {
    loopFrameRef.current = undefined;
    const map = mapContext?.map;
    const fixes = track;
    if (!map) return;
    if (fixes.length === 0) {
      playheadRef.current = null;
      smoothedCourseRef.current = null;
      cameraBearingRef.current = null;
      legRef.current = null;
      lastFixArrivalRef.current = null;
      lastFixTsRef.current = null;
      return;
    }

    const dt = Math.min(now - lastStepAtRef.current, 1000);
    lastStepAtRef.current = now;

    const last = fixes[fixes.length - 1];
    let playhead = playheadRef.current;
    if (!playhead || playhead.index >= fixes.length) {
      playhead = { ts: last.timestamp, index: fixes.length - 1 };
      legRef.current = null;
    }
    // Timestamps survive a track heal/reindex; the cached index does not.
    // If the fix under the index moved ahead of the playhead, restart the
    // index — the advance loop below re-derives it in one pass.
    if (fixes[playhead.index].timestamp > playhead.ts) {
      playhead.index = 0;
    }

    const previousTs = playhead.ts;
    const leg = legRef.current;
    if (leg) {
      playhead.ts = Math.min(leg.toTs, playhead.ts + leg.rate * dt);
      if (playhead.ts >= leg.toTs) legRef.current = null;
    }
    while (
      playhead.index < fixes.length - 1 &&
      fixes[playhead.index + 1].timestamp <= playhead.ts
    ) {
      playhead.index++;
    }
    playheadRef.current = playhead;

    const a = fixes[playhead.index];
    const b = fixes[playhead.index + 1];
    let display: DisplayPosition;
    if (b) {
      const span = b.timestamp - a.timestamp;
      const t =
        span > 0
          ? Math.min(1, Math.max(0, (playhead.ts - a.timestamp) / span))
          : 1;
      display = {
        lng: a.longitude + (b.longitude - a.longitude) * t,
        lat: a.latitude + (b.latitude - a.latitude) * t,
        course: a.course + relativeBearing(a.course, b.course) * t,
      };
    } else {
      display = { lng: a.longitude, lat: a.latitude, course: a.course };
    }

    // Low-pass the heading: segment-wise lerp alone kinks at every fix
    // boundary, which reads as snapping (worst in track-up). Smoothing runs
    // on the playhead's clock, not wall time, so it keeps pace with the turn
    // at any playback compression.
    const smoothFactor = Math.min(
      1,
      (playhead.ts - previousTs) / COURSE_SMOOTH_MS,
    );
    const prevCourse = smoothedCourseRef.current;
    const smoothedCourse =
      prevCourse === null
        ? display.course
        : prevCourse +
          relativeBearing(prevCourse, display.course) * smoothFactor;
    smoothedCourseRef.current = normalizeDeg(smoothedCourse);
    display.course = smoothedCourseRef.current;

    // The camera bearing chases its target through the same loop instead of
    // an easeTo: an ease would pause recentering for its whole duration
    // (isRotating) while the aircraft keeps moving. Unlike the aircraft
    // heading, it smooths in REAL time — it rotates the entire viewport, so
    // its rate must stay comfortable at any playback compression.
    const bearingTarget = trackUp ? display.course : 0;
    const align = bearingAlignRef.current;
    const prevBearing = cameraBearingRef.current;
    if (align) {
      const progress = Math.min(1, (now - align.startedAt) / ALIGN_ROTATE_MS);
      cameraBearingRef.current = normalizeDeg(
        align.from + relativeBearing(align.from, bearingTarget) * progress,
      );
      if (progress >= 1) bearingAlignRef.current = null;
    } else {
      cameraBearingRef.current =
        prevBearing === null
          ? bearingTarget
          : normalizeDeg(
              prevBearing +
                relativeBearing(prevBearing, bearingTarget) *
                  Math.min(1, dt / BEARING_SMOOTH_MS),
            );
    }

    // While following, the loop owns wheel zoom too: gliding it here in the
    // same jumpTo as center/bearing means nothing fights the camera.
    let zoom: number | undefined;
    const zoomTarget = zoomTargetRef.current;
    if (zoomTarget !== null) {
      const currentZoom = map.getZoom();
      const nextZoom =
        currentZoom +
        (zoomTarget - currentZoom) * Math.min(1, dt / ZOOM_SMOOTH_MS);
      if (Math.abs(zoomTarget - nextZoom) < 0.002) {
        zoomTargetRef.current = null;
        zoom = zoomTarget;
      } else {
        zoom = nextZoom;
      }
    }

    syncLine(map);
    renderFrame(map, display, zoom);

    if (
      legRef.current !== null ||
      zoomTargetRef.current !== null ||
      bearingAlignRef.current !== null
    ) {
      loopFrameRef.current = requestAnimationFrame((next) =>
        stepPlayhead(next),
      );
    }
  });

  const ensureLoop = useEffectEvent(() => {
    if (loopFrameRef.current !== undefined) return;
    lastStepAtRef.current = performance.now();
    loopFrameRef.current = requestAnimationFrame((next) => stepPlayhead(next));
  });

  // Fast refresh preserves refs but re-runs effects: clear the frame id so
  // ensureLoop can restart the loop after HMR instead of seeing a stale id.
  useEffect(
    () => () => {
      if (loopFrameRef.current) cancelAnimationFrame(loopFrameRef.current);
      loopFrameRef.current = undefined;
    },
    [],
  );

  // An Effect Event: the style.load listener is registered once, but the
  // dispatch here always runs the latest render's body (fresh track prop).
  const ensureTrackLayers = useEffectEvent(
    (map: MapLibreMap, lib: MapLibreModule) => {
      if (!map.isStyleLoaded()) return;
      if (map.getSource("track")) return;
      map.addSource("track", { type: "geojson", data: toLineData([]) });
      map.addLayer({
        id: "track",
        type: "line",
        source: "track",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#4cc2ff", "line-width": LINE_WIDTH_PX },
      });
      lineCoordsRef.current = [];
      lineEndTsRef.current = null;
      committedCountRef.current = 0;
      pendingCountRef.current = null;
      confirmArmedRef.current = false;
      syncLine(map);

      if (!map.getLayer("aircraft")) {
        map.addLayer(createAircraftLayer(lib, () => getAircraftFrame(map)));
        map.getContainer().setAttribute("data-aircraft-layer", "true");
      }
      if (displayRef.current) renderFrame(map, displayRef.current);
    },
  );

  const handleDragStart = useEffectEvent(() => {
    onFollowChange(false);
  });

  // While following, scrollZoom's smooth ease and the per-frame jumpTo would
  // fight (killed eases read as slow, choppy zoom). Intercept the wheel and
  // let the follow loop glide zoom itself; unpinned keeps native behavior.
  const handleWheel = useEffectEvent((event: MapWheelEvent) => {
    const map = mapContext?.map;
    if (!map) return;
    if (!follow || interactingRef.current) return;
    event.preventDefault();
    const original = event.originalEvent;
    const rate = original.ctrlKey ? PINCH_ZOOM_RATE : WHEEL_ZOOM_RATE;
    const from = zoomTargetRef.current ?? map.getZoom();
    zoomTargetRef.current = Math.min(
      map.getMaxZoom(),
      Math.max(map.getMinZoom(), from - original.deltaY * rate),
    );
    ensureLoop();
  });

  const setupMap = useEffectEvent(({ map, lib }: MapContext) => {
    applyZoomAnchor(map, follow);
    // style.load alone is not enough: it can fire before this listener is
    // registered, and isStyleLoaded() stays false until sprites/glyphs and
    // sources finish after it. styledata + idle + a direct attempt make
    // layer creation eventually consistent; ensureTrackLayers is idempotent
    // and declines until the style can accept layers.
    map.on("style.load", () => ensureTrackLayers(map, lib));
    map.on("styledata", () => ensureTrackLayers(map, lib));
    map.on("idle", () => ensureTrackLayers(map, lib));
    ensureTrackLayers(map, lib);
    map.on("mousedown", () => {
      interactingRef.current = true;
    });
    map.on("touchstart", () => {
      interactingRef.current = true;
    });
    map.on("mouseup", () => {
      interactingRef.current = false;
    });
    map.on("touchend", () => {
      interactingRef.current = false;
    });
    map.on("touchcancel", () => {
      interactingRef.current = false;
    });
    map.on("dragend", () => {
      interactingRef.current = false;
      const center = map.getCenter();
      writeLiveViewState({ center: [center.lng, center.lat] });
    });
    map.on("dragstart", () => handleDragStart());
    map.on("wheel", (event) => handleWheel(event));
    map.on("zoomend", () => {
      writeLiveViewState({ zoom: map.getZoom() });
    });

    const last = track[track.length - 1];
    if (last) {
      positionInitializedRef.current = true;
      const saved = readLiveViewState();
      const center: [number, number] =
        !follow && saved.center
          ? saved.center
          : [last.longitude, last.latitude];
      map.jumpTo({
        center,
        zoom: saved.zoom ?? 13,
        bearing: trackUp ? last.course : 0,
        padding: cameraPadding(),
      });
      ensureLoop();
    }
  });

  useEffect(() => {
    if (mapContext) setupMap(mapContext);
  }, [mapContext]);

  const handleNewFix = useEffectEvent((fix: Fix) => {
    const map = mapContext?.map;
    if (!map) return;
    if (!positionInitializedRef.current) {
      positionInitializedRef.current = true;
      map.jumpTo({
        center: [fix.longitude, fix.latitude],
        zoom: readLiveViewState().zoom ?? 13,
        bearing: trackUp ? fix.course : 0,
        padding: cameraPadding(),
      });
    }

    const now = performance.now();
    const lastArrival = lastFixArrivalRef.current;
    const lastFixTs = lastFixTsRef.current;
    if (lastArrival !== null && lastFixTs !== null) {
      const arrivalDelta = Math.min(
        FIX_INTERVAL_MAX_MS,
        Math.max(FIX_INTERVAL_MIN_MS, now - lastArrival),
      );
      fixIntervalEmaRef.current =
        fixIntervalEmaRef.current * (1 - FIX_INTERVAL_EMA_ALPHA) +
        arrivalDelta * FIX_INTERVAL_EMA_ALPHA;
      const trackDelta = fix.timestamp - lastFixTs;
      if (trackDelta > 0) {
        const rate = Math.min(500, Math.max(0.1, trackDelta / arrivalDelta));
        trackRateEmaRef.current =
          trackRateEmaRef.current * (1 - FIX_INTERVAL_EMA_ALPHA) +
          rate * FIX_INTERVAL_EMA_ALPHA;
      }
    }
    lastFixArrivalRef.current = now;
    lastFixTsRef.current = fix.timestamp;

    const playhead = playheadRef.current;
    if (playhead) {
      const backlogTrackMs = fix.timestamp - playhead.ts;
      const backlogRealMs = backlogTrackMs / trackRateEmaRef.current;
      if (backlogRealMs > SNAP_LAG_REAL_MS) {
        // Hopelessly behind (backgrounded tab): jump instead of animating.
        playhead.ts = fix.timestamp;
        legRef.current = null;
      } else if (backlogTrackMs > 0) {
        const duration = Math.max(
          fixIntervalEmaRef.current * LEG_DURATION_PAD,
          backlogRealMs / MAX_CATCHUP_RATE,
        );
        legRef.current = {
          toTs: fix.timestamp,
          rate: backlogTrackMs / duration,
        };
      }
    }
    ensureLoop();
  });

  useEffect(() => {
    if (latest) handleNewFix(latest);
  }, [latest]);

  const applyFollowChange = useEffectEvent((following: boolean) => {
    const map = mapContext?.map;
    if (!map) return;
    applyZoomAnchor(map, following);
    const position = displayRef.current;
    if (!following || !position) return;
    const bearing = trackUp ? position.course : 0;
    cameraBearingRef.current = bearing;
    map.jumpTo({
      center: [position.lng, position.lat],
      zoom: Math.max(map.getZoom(), 11),
      bearing,
      padding: cameraPadding(),
    });
  });

  useEffect(() => {
    applyFollowChange(follow);
  }, [follow]);

  const applyTrackUpChange = useEffectEvent((trackingUp: boolean) => {
    const map = mapContext?.map;
    if (!map) return;
    const bearing = trackingUp ? (displayRef.current?.course ?? 0) : 0;
    if (follow) {
      // A short constant-duration rotation instead of an instant snap:
      // seeing the world turn is what tells the pilot where north went.
      bearingAlignRef.current = {
        from: cameraBearingRef.current ?? map.getBearing(),
        startedAt: performance.now(),
      };
      ensureLoop();
      return;
    }
    map.easeTo({ bearing, duration: ALIGN_ROTATE_MS });
  });

  useEffect(() => {
    applyTrackUpChange(trackUp);
  }, [trackUp]);

  return (
    <div className="live-map">
      <MapView
        view={view}
        onReady={(map, lib) => setMapContext({ map, lib })}
      />
    </div>
  );
}
