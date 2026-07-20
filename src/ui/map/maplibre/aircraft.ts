import { MercatorCoordinate } from "maplibre-gl";
import type { CustomLayerInterface, Map as MapLibreMap } from "maplibre-gl";

import type { AircraftState } from "../types";

// The aircraft glyph, drawn as a WebGL custom layer so it renders inside the
// map's own GL frame (in sync with the base map, no per-frame DOM). This is
// the MapLibre backend's implementation of the intent-based `aircraft()`
// handle — the MapKit backend renders the same {position, heading} as an
// annotation. The flown line (a Line) reaches the aircraft, so there is no
// separate tail.
const ARROW_PX = 46;

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

export function createAircraftLayer(
  getState: () => AircraftState | null,
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
      const state = getState();
      if (!state || !program) return;
      const [lng, lat] = state.at;
      const course = state.heading;

      const projection = args as unknown as {
        defaultProjectionData?: { mainMatrix: number[] | Float32Array };
      };
      const matrix =
        projection?.defaultProjectionData?.mainMatrix ??
        (args as unknown as Float32Array);

      const anchor = MercatorCoordinate.fromLngLat([lng, lat]);
      const worldSize = 512 * Math.pow(2, map.getZoom());

      // Vertices are anchor-relative so Float32 stays precise at high zoom;
      // the anchor translation folds into the matrix in double precision.
      const translated = new Array<number>(16);
      for (let i = 0; i < 12; i++) translated[i] = matrix[i];
      for (let i = 0; i < 4; i++) {
        translated[12 + i] =
          matrix[i] * anchor.x + matrix[4 + i] * anchor.y + matrix[12 + i];
      }

      // Two passes: a 1.25× dark outline behind a 1× blue fill.
      const vertices: number[] = [];
      const unitsPerArrowUnit = ARROW_PX / 24 / worldSize;
      const radians = (course * Math.PI) / 180;
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
      gl.uniform4fv(uColor, OUTLINE_COLOR);
      gl.drawArrays(gl.TRIANGLES, 0, ARROW_SHAPE.length);
      gl.uniform4fv(uColor, FILL_COLOR);
      gl.drawArrays(gl.TRIANGLES, ARROW_SHAPE.length, ARROW_SHAPE.length);
    },
  };
}
