import type { Feature } from "geojson";
import type {
  CustomLayerInterface,
  GeoJSONSource,
  Map as MapLibreMap,
} from "maplibre-gl";
import { useEffect, useRef } from "react";

import type { Fix } from "../engine/types";
import { relativeBearing } from "../flight/nav";
import MapView, { type MapLibreModule } from "./MapView";
import { labelInsertionPoint } from "./layers";
import { readLiveViewState, writeLiveViewState } from "./liveViewState";
import type { MapViewKind } from "./config";
import "./LiveTrackMap.css";

const CHASE_MS = 800;
const COURSE_SMOOTH_MS = 400;
const BEARING_SMOOTH_MS = 800;
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

export default function LiveTrackMap({
  track,
  latest,
  view,
  follow,
  trackUp,
  topInset = 0,
  onFollowChange,
}: LiveTrackMapProps) {
  const mapRef = useRef<MapLibreMap | null>(null);
  const libRef = useRef<MapLibreModule | null>(null);
  const positionInitializedRef = useRef(false);
  const trackRef = useRef(track);
  trackRef.current = track;
  const followRef = useRef(follow);
  followRef.current = follow;
  const trackUpRef = useRef(trackUp);
  trackUpRef.current = trackUp;
  const interactingRef = useRef(false);
  const onFollowChangeRef = useRef(onFollowChange);
  onFollowChangeRef.current = onFollowChange;
  const topInsetRef = useRef(topInset);
  topInsetRef.current = topInset;
  const displayRef = useRef<DisplayPosition | null>(null);
  const lineCoordsRef = useRef<[number, number][]>([]);
  const committedCountRef = useRef(0);
  const pendingCountRef = useRef<number | null>(null);
  const confirmArmedRef = useRef(false);
  const lastCommitAtRef = useRef(0);
  const playheadRef = useRef<{ ts: number; index: number } | null>(null);
  const smoothedCourseRef = useRef<number | null>(null);
  const cameraBearingRef = useRef<number | null>(null);
  const loopFrameRef = useRef<number | undefined>(undefined);
  const lastStepAtRef = useRef(0);

  function cameraPadding() {
    return {
      top: OVERSCAN_PX + topInsetRef.current,
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
    const fixes = trackRef.current;
    const playhead = playheadRef.current;
    const upTo = playhead ? Math.min(playhead.index + 1, fixes.length) : 0;
    if (lineCoordsRef.current.length > upTo) {
      lineCoordsRef.current = [];
      committedCountRef.current = 0;
      pendingCountRef.current = null;
      confirmArmedRef.current = false;
      const source = map.getSource("track") as GeoJSONSource | undefined;
      source?.setData(toLineData([]));
    }
    while (lineCoordsRef.current.length < upTo) {
      const fix = fixes[lineCoordsRef.current.length];
      lineCoordsRef.current.push([fix.longitude, fix.latitude]);
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

  function renderFrame(position: DisplayPosition) {
    displayRef.current = position;
    const map = mapRef.current;
    if (!map) return;

    (
      map.getContainer() as HTMLElement & { __display?: DisplayPosition }
    ).__display = position;

    if (followRef.current && !interactingRef.current) {
      map.jumpTo({
        center: [position.lng, position.lat],
        bearing:
          cameraBearingRef.current ??
          (trackUpRef.current ? position.course : 0),
        padding: cameraPadding(),
      });
    } else {
      map.triggerRepaint();
    }
  }

  // The playhead travels along the recorded track polyline, chasing the
  // newest fix with an exponential rubber-band (steady-state lag ≈ CHASE_MS).
  // Both the aircraft and the line derive from it, so they cannot diverge.
  function stepPlayhead(now: number) {
    loopFrameRef.current = undefined;
    const map = mapRef.current;
    const fixes = trackRef.current;
    if (!map) return;
    if (fixes.length === 0) {
      playheadRef.current = null;
      smoothedCourseRef.current = null;
      cameraBearingRef.current = null;
      return;
    }

    const dt = Math.min(now - lastStepAtRef.current, 1000);
    lastStepAtRef.current = now;

    const last = fixes[fixes.length - 1];
    let playhead = playheadRef.current;
    if (!playhead || playhead.index >= fixes.length) {
      playhead = { ts: last.timestamp, index: fixes.length - 1 };
    }

    const previousTs = playhead.ts;
    const remaining = last.timestamp - playhead.ts;
    if (remaining > 0) {
      playhead.ts += remaining * Math.min(1, dt / CHASE_MS);
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
    const bearingTarget = trackUpRef.current ? display.course : 0;
    const prevBearing = cameraBearingRef.current;
    cameraBearingRef.current =
      prevBearing === null
        ? bearingTarget
        : normalizeDeg(
            prevBearing +
              relativeBearing(prevBearing, bearingTarget) *
                Math.min(1, dt / BEARING_SMOOTH_MS),
          );

    syncLine(map);
    renderFrame(display);

    if (playhead.ts < last.timestamp - 1) {
      loopFrameRef.current = requestAnimationFrame(stepPlayhead);
    }
  }

  function ensureLoop() {
    if (loopFrameRef.current !== undefined) return;
    lastStepAtRef.current = performance.now();
    loopFrameRef.current = requestAnimationFrame(stepPlayhead);
  }

  // Fast refresh preserves refs but re-runs effects: clear the frame id so
  // ensureLoop can restart the loop after HMR instead of seeing a stale id.
  useEffect(
    () => () => {
      if (loopFrameRef.current) cancelAnimationFrame(loopFrameRef.current);
      loopFrameRef.current = undefined;
    },
    [],
  );

  function ensureTrackLayers(map: MapLibreMap) {
    if (map.getSource("track")) return;
    map.addSource("track", { type: "geojson", data: toLineData([]) });
    const firstSymbol = labelInsertionPoint(map);
    map.addLayer(
      {
        id: "track",
        type: "line",
        source: "track",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#4cc2ff", "line-width": LINE_WIDTH_PX },
      },
      firstSymbol,
    );
    lineCoordsRef.current = [];
    committedCountRef.current = 0;
    pendingCountRef.current = null;
    confirmArmedRef.current = false;
    syncLine(map);

    const lib = libRef.current;
    if (lib && !map.getLayer("aircraft")) {
      map.addLayer(
        createAircraftLayer(lib, () => getAircraftFrame(map)),
        firstSymbol,
      );
      map.getContainer().setAttribute("data-aircraft-layer", "true");
    }
    if (displayRef.current) renderFrame(displayRef.current);
  }

  function handleReady(map: MapLibreMap, lib: MapLibreModule) {
    mapRef.current = map;
    libRef.current = lib;
    applyZoomAnchor(map, followRef.current);
    map.on("style.load", () => ensureTrackLayers(map));
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
    map.on("dragstart", () => {
      followRef.current = false;
      onFollowChangeRef.current(false);
    });
    map.on("zoomend", () => {
      writeLiveViewState({ zoom: map.getZoom() });
    });

    const last = trackRef.current[trackRef.current.length - 1];
    if (last) {
      positionInitializedRef.current = true;
      const saved = readLiveViewState();
      const center: [number, number] =
        !followRef.current && saved.center
          ? saved.center
          : [last.longitude, last.latitude];
      map.jumpTo({
        center,
        zoom: saved.zoom ?? 13,
        bearing: trackUpRef.current ? last.course : 0,
        padding: cameraPadding(),
      });
      ensureLoop();
    }
  }

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !latest) return;

    if (!positionInitializedRef.current) {
      positionInitializedRef.current = true;
      map.jumpTo({
        center: [latest.longitude, latest.latitude],
        zoom: readLiveViewState().zoom ?? 13,
        bearing: trackUpRef.current ? latest.course : 0,
        padding: cameraPadding(),
      });
    }
    ensureLoop();
  }, [latest]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    applyZoomAnchor(map, follow);
    const position = displayRef.current;
    if (!follow || !position) return;
    const bearing = trackUpRef.current ? position.course : 0;
    cameraBearingRef.current = bearing;
    map.jumpTo({
      center: [position.lng, position.lat],
      zoom: Math.max(map.getZoom(), 11),
      bearing,
      padding: cameraPadding(),
    });
  }, [follow]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || followRef.current) return;
    map.easeTo({
      bearing: trackUp ? (displayRef.current?.course ?? 0) : 0,
      duration: 400,
    });
  }, [trackUp]);

  return (
    <div className="live-map">
      <MapView view={view} onReady={handleReady} />
    </div>
  );
}
