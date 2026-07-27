import type { CustomLayerInterface, Map as MapLibreMap } from "maplibre-gl";

/**
 * The offline basemap's grid, drawn as a WebGL custom layer.
 *
 * There is no geometry. A single screen-covering quad is drawn and the lines
 * are computed per fragment, which is what makes this both cheap and exact:
 *
 * - Cheap, and that is the point on the flight surface. The live map follows
 *   the aircraft, so it pans continuously for hours; a GeoJSON graticule has
 *   to re-generate, re-parse (in a worker) and re-upload its lines every time
 *   the viewport leaves what was drawn. This uploads four vertices per frame
 *   and never touches a worker.
 *
 * - Exact, because the coarse grid and the subdivision fading into it are
 *   evaluated in the same shader, from the same uniforms, in the same frame.
 *   Nothing can arrive late relative to anything else. The earlier
 *   style-driven attempts glitched precisely because setPaintProperty,
 *   setFilter (~145ms of worker re-parse) and setData land at different
 *   times, so a band flip was never atomic. Here it is atomic by
 *   construction: at the instant spacing halves, the fine grid is already at
 *   full opacity and simply becomes the coarse one, so the rendered result is
 *   bit-identical across the change.
 */

// Roughly how many established cells span the viewport width. The count
// drifts between this and half of it as a band is zoomed through, and the
// subdivision doubles it again while fading in — so the busiest moment shows
// about 2x this. Tuned by eye on a phone: the grid is a reference, not a
// texture.
const TARGET_BOXES = 5;
const LINE_WIDTH_PX = 1;
// Per appearance: the same mid-grey that reads on a dark backdrop all but
// vanishes on a light one, so the light variant goes darker instead.
const LINE_COLOR: Record<"light" | "dark", [number, number, number]> = {
  dark: [0.447, 0.49, 0.549], // #727d8c
  light: [0.42, 0.45, 0.5],
};
// Opacity of a fully established line. Deliberately quiet: the grid is a
// reference for drift and scale, and it shares the screen with the track,
// which must always be the brightest thing on it.
const LINE_ALPHA = 0.24;

// Mercator is not degrees: spacing is a power-of-two fraction of the world,
// so cells stay SQUARE on screen at any latitude (a lat/lon graticule
// stretches with the projection) and each level halves the last exactly.
const VERTEX_SHADER = `
attribute vec2 a_pos;
varying vec2 v_pos;
uniform mat4 u_matrix;
void main() {
  v_pos = a_pos;
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
}`;

// Distance to the nearest line is converted to PIXELS analytically, from a
// uniform, rather than with fwidth(). That keeps this on plain GLSL ES 1.00
// with no derivatives extension to feature-detect.
//
// It assumes a uniform scale across the frame, which holds only while the map
// is unpitched. The adapter builds every map with maxPitch 0, so that is not a
// hope: a pitched map cannot occur. Rotation is fine — it preserves scale.
const FRAGMENT_SHADER = `
precision highp float;
varying vec2 v_pos;
uniform float u_spacing;
uniform float u_pxPerUnit;
uniform float u_fade;
uniform float u_width;
uniform vec3 u_color;
uniform float u_alpha;

float grid(vec2 pos, float spacing, float pxPerUnit) {
  vec2 cell = pos / spacing;
  vec2 distPx = abs(fract(cell - 0.5) - 0.5) * spacing * pxPerUnit;
  float nearest = min(distPx.x, distPx.y);
  // Solid within half the width, then one pixel of falloff: an antialiased
  // hairline at any zoom, with no texture and no geometry.
  return clamp(u_width * 0.5 + 0.5 - nearest, 0.0, 1.0);
}

void main() {
  float coarse = grid(v_pos, u_spacing, u_pxPerUnit);
  float fine = grid(v_pos, u_spacing * 0.5, u_pxPerUnit);
  // The fine grid CONTAINS the coarse one, so max() leaves established lines
  // solid and lifts only the half-steps between them.
  float alpha = max(coarse, u_fade * fine);
  if (alpha <= 0.0) discard;
  // PREMULTIPLIED, because that is what maplibre's context and blend func
  // expect (premultipliedAlpha: true, [ONE, ONE_MINUS_SRC_ALPHA]). Emitting
  // straight colour only looked right because the grid sits on an opaque
  // backdrop; over anything transparent the canvas alpha collapses toward a²
  // and on the light appearance the lines composite BRIGHTER than their
  // background, which is the polarity inverted.
  float out_a = u_alpha * alpha;
  gl_FragColor = vec4(u_color * out_a, out_a);
}`;

function compile(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    // Silent shader failure means an invisible grid on the one basemap that
    // has nothing else on it, so say so rather than render nothing.
    console.error("graticule shader failed:", gl.getShaderInfoLog(shader));
  }
  return shader;
}

/**
 * Spacing (in mercator units) of the established grid, and how far the
 * subdivision below it has faded in.
 *
 * Zooming in spreads the established lines apart; once a box has grown
 * enough the line splitting it fades up, and by the time the box has doubled
 * that line is solid and IS the established grid. Apparent density never
 * changes and nothing pops.
 */
function mercY(lat: number) {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

export function gridForZoom(zoom: number, viewportPx: number) {
  const worldSize = 512 * 2 ** zoom;
  // A hidden tab reports clientWidth 0, and log2(0) is -Infinity: it would
  // poison both uniforms and divide by zero in the shader. Nothing is visible
  // at that size anyway.
  if (viewportPx <= 0) return { spacing: 1, fade: 0, worldSize };
  const target = viewportPx / worldSize / TARGET_BOXES;
  const level = Math.log2(target);
  const spacing = 2 ** Math.ceil(level);
  const progress = Math.ceil(level) - level;
  // Cubic: imperceptible while the parent box is still small, arriving over
  // the second half of the zoom, with no dead zone at either end.
  return { spacing, fade: progress ** 3, worldSize };
}

export function createGraticuleLayer(
  id: string,
  getAppearance: () => "light" | "dark",
): CustomLayerInterface {
  let map: MapLibreMap;
  let program: WebGLProgram | null = null;
  // Deleted with the layer: the program and buffer were freed, the shaders
  // were not, so each add/remove leaked two.
  const shaders: WebGLShader[] = [];
  let buffer: WebGLBuffer;
  let aPos: number;
  let uMatrix: WebGLUniformLocation;
  let uSpacing: WebGLUniformLocation;
  let uPxPerUnit: WebGLUniformLocation;
  let uFade: WebGLUniformLocation;
  let uWidth: WebGLUniformLocation;
  let uColor: WebGLUniformLocation;
  let uAlpha: WebGLUniformLocation;

  // Reused: the live map follows the aircraft, so render() runs continuously
  // for the length of a flight.
  const translated = new Float32Array(16);
  const quad = new Float32Array(8);

  return {
    id,
    type: "custom",
    renderingMode: "2d",

    onAdd(addedMap, gl) {
      map = addedMap;
      program = gl.createProgram()!;
      shaders.push(
        compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER),
        compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER),
      );
      for (const shader of shaders) gl.attachShader(program, shader);
      gl.linkProgram(program);
      aPos = gl.getAttribLocation(program, "a_pos");
      uMatrix = gl.getUniformLocation(program, "u_matrix")!;
      uSpacing = gl.getUniformLocation(program, "u_spacing")!;
      uPxPerUnit = gl.getUniformLocation(program, "u_pxPerUnit")!;
      uFade = gl.getUniformLocation(program, "u_fade")!;
      uWidth = gl.getUniformLocation(program, "u_width")!;
      uColor = gl.getUniformLocation(program, "u_color")!;
      uAlpha = gl.getUniformLocation(program, "u_alpha")!;
      buffer = gl.createBuffer()!;
    },

    onRemove(_map, gl) {
      for (const shader of shaders) gl.deleteShader(shader);
      shaders.length = 0;
      if (program) gl.deleteProgram(program);
      gl.deleteBuffer(buffer);
      program = null;
    },

    render(gl, args) {
      if (!program) return;
      const projection = args as unknown as {
        defaultProjectionData?: { mainMatrix: number[] | Float32Array };
      };
      const matrix =
        projection?.defaultProjectionData?.mainMatrix ??
        (args as unknown as Float32Array);

      const canvas = map.getCanvas();
      const { spacing, fade, worldSize } = gridForZoom(
        map.getZoom(),
        canvas.clientWidth,
      );

      // The quad spans the visible mercator box, padded so rotation cannot
      // expose a corner. getBounds already covers the rotated viewport.
      const bounds = map.getBounds();
      const sw = bounds.getSouthWest();
      const ne = bounds.getNorthEast();
      const x0 = (sw.lng + 180) / 360;
      const x1 = (ne.lng + 180) / 360;
      const y0 = mercY(ne.lat);
      const y1 = mercY(sw.lat);
      const padX = (x1 - x0) * 0.5 || spacing;
      const padY = (y1 - y0) * 0.5 || spacing;

      // Vertices are anchor-relative so Float32 stays precise at high zoom,
      // and the anchor is a whole number of cells so the grid phase is
      // unchanged by subtracting it. The translation folds into the matrix in
      // double precision, exactly as the aircraft layer does.
      const anchorX = Math.floor((x0 + x1) / 2 / spacing) * spacing;
      const anchorY = Math.floor((y0 + y1) / 2 / spacing) * spacing;
      const left = x0 - padX - anchorX;
      const right = x1 + padX - anchorX;
      const top = y0 - padY - anchorY;
      const bottom = y1 + padY - anchorY;

      for (let i = 0; i < 12; i++) translated[i] = matrix[i]!;
      for (let i = 0; i < 4; i++) {
        translated[12 + i] =
          matrix[i]! * anchorX + matrix[4 + i]! * anchorY + matrix[12 + i]!;
      }

      gl.useProgram(program);
      gl.uniformMatrix4fv(uMatrix, false, translated);
      gl.uniform1f(uSpacing, spacing);
      gl.uniform1f(
        uPxPerUnit,
        worldSize * (window.devicePixelRatio || 1) * 1.0,
      );
      gl.uniform1f(uFade, fade);
      gl.uniform1f(uWidth, LINE_WIDTH_PX * (window.devicePixelRatio || 1));
      gl.uniform3fv(uColor, LINE_COLOR[getAppearance()]);
      gl.uniform1f(uAlpha, LINE_ALPHA);

      quad[0] = left;
      quad[1] = top;
      quad[2] = right;
      quad[3] = top;
      quad[4] = left;
      quad[5] = bottom;
      quad[6] = right;
      quad[7] = bottom;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, quad, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
      // No blendFunc: maplibre already set [ONE, ONE_MINUS_SRC_ALPHA] for the
      // translucent pass, which is the premultiplied pairing the shader emits
      // for. Overriding it was the other half of the same bug.
      gl.enable(gl.BLEND);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
  };
}
