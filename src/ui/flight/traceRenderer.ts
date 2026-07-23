/**
 * traceRenderer — WebGL2 backdrop: a glowing comet retraces the last flight.
 *
 * The effect is the idle-screen wallpaper on FlyPage: a point-headed comet
 * flies launch → landing along the pilot's smoothed track, over a TRANSPARENT
 * canvas so the page background composites behind it (pure black in dark mode,
 * pure white in light mode). Because the same effect has to read on both, the
 * module carries a glow/ink duality baked into how bloom is composited — and
 * ink draws NO head sprite at all (emissive and sharp passes alike): the
 * light-mode comet is deliberately the bare trail.
 *
 * Per-frame pipeline:
 *   1. EMISSIVE PASS → a HALF-resolution offscreen FBO. The tapered trail
 *      ribbon and the head sprite are drawn ADDITIVELY into it, so overlapping
 *      light accumulates and the head clips to a hot core. Half-res is the
 *      first (and cheapest) half of the bloom trick.
 *   2. SEPARABLE GAUSSIAN → two half-res passes (horizontal, then vertical),
 *      13 taps each. Tap spacing scales with dpr so the *visual* blur radius is
 *      device-independent (~20-24 CSS px). Blurring premultiplied colour is
 *      linear, so no un/re-multiply dance is needed.
 *   3. COMPOSITE the blurred field over the transparent default framebuffer:
 *        - "glow" (dark mode): additive light over pure black IS a real glow,
 *          so we ADD the blurred colour (blendFunc ONE, ONE).
 *        - "ink" (light mode): additive light is invisible on white, so instead
 *          we blend the blur as a normal-alpha VEIL tinted by `body` — alpha =
 *          blurred luminance, clamped so the halo stays subtle. The comet then
 *          reads as saturated pigment with a soft coloured aura.
 *   4. SHARP PASS: redraw the crisp trail + head on top of the bloom so the
 *      centre stays a hard point of light inside its own halo.
 *   The GHOST hairline (the whole track) is drawn first, UNDER the bloom, and
 *   is never part of the emissive pass — it is a plain anti-aliased thread.
 *
 * Everything outputs correct PREMULTIPLIED alpha over a (0,0,0,0) clear: the
 * caller's context is { alpha: true, premultipliedAlpha: true, antialias:
 * false }, and the browser composites the canvas over the page. On the
 * spec-guaranteed pure-black page the additive glow's premultiplied RGB IS the
 * final colour; on the white page the ink veil / pigment darkens it.
 *
 * Geometry is tessellated ONCE (in setPath): the polyline becomes a triangle
 * strip carrying screen-space normals and per-vertex arc-length s ∈ [0,1]. All
 * per-frame animation (trail window, taper, head position) is expressed as
 * shader uniforms, so a frame is just uniform writes + a handful of draws — no
 * CPU re-tessellation, no per-frame allocation.
 */

export type RGB = [number, number, number];

export interface TraceTheme {
  // "glow": dark mode — emissive comet, bloom composited ADDITIVELY.
  // "ink": light mode — pigment comet on white; bloom output is composited
  //        as an alpha-blended tinted halo (additive light is invisible on
  //        white), so the comet reads as saturated ink with a soft halo.
  mode: "glow" | "ink";
  body: RGB; // trail color, components 0..1 (already in the buffer's color space)
  head: RGB; // head-point color
  ghost: RGB; // full-track hairline color
  ghostAlpha: number; // 0..1
}

export interface TraceRenderer {
  resize(width: number, height: number, dpr: number): void; // CSS px + devicePixelRatio
  setPath(points: Float32Array): void; // [x0,y0, x1,y1, ...] in CSS px, ≥2 points, already smoothed/evenly spaced
  setTheme(theme: TraceTheme): void;
  render(phase: number): void; // draws one frame; phase in [0, 1.25)
  destroy(): void; // delete all GL resources; renderer unusable after
}

// --- Tunable constants (CSS-px unless noted; dpr is applied in the shaders) ---

// The comet's trailing window is 18% of the arc length; the "hidden runway"
// past phase 1.0 lets that window keep draining off the far end of the path
// before the tail finally clears at phase 1.0 + WINDOW.
const TRAIL_WINDOW = 0.18;

// Ribbon width tapers narrow→wide toward the head; the head-side width is where
// the bloom concentrates. Ghost is a constant hairline.
const WIDTH_TAIL = 1.5;
const WIDTH_HEAD = 6.0;
const GHOST_WIDTH = 1.5;

// Round the leading tip of the trail into a semicircular cap instead of a flat
// cut. Flip to false for a blunt end.
const ROUND_HEAD = true;

// Feather envelope (device px) added on each side of the ribbon so the coverage
// smoothstep has room to fall to zero — WebGL lineWidth is unreliable, so all
// edges are SDF-feathered in screen space instead.
const AA_PAD = 1.5;

// Head sprite: a gaussian point. HEAD_QUAD is the quad half-extent (the sprite's
// bounding radius); HEAD_CORE is the visual core radius. HEAD_FALLOFF is chosen
// so the gaussian is ~e^-0.5 at the core edge and ~0 by the quad corner. Kept
// small on purpose — a tight point of light, not a blob.
const HEAD_CORE = 5.5;
const HEAD_QUAD = 16.0;
const HEAD_FALLOFF = 0.5 / ((HEAD_CORE / HEAD_QUAD) * (HEAD_CORE / HEAD_QUAD));

// The head is still a touch over-bright so it clips to a hot centre in the
// additive emissive buffer (→ a distinct bloomed point, brighter than the
// trail), but only just — it should read as a small spark, not a headlight.
const HEAD_INTENSITY_EMISSIVE = 1.1;
const HEAD_INTENSITY_SHARP = 0.8;
const TRAIL_ALPHA = 1.0;

// Head "landing" fade: the comet touches down over this phase window.
const LAND_START = 1.0;
const LAND_END = 1.04;

// A gentle richer-cyan bias for the drawn comet vs. the raw theme colour: a
// small saturation boost plus a slight cyan tilt (suppress red, lift green/
// blue). Subtle by design — the head core still clips bright in the additive
// buffer. The ghost keeps the untouched theme colour.
const SAT_BOOST = 1.28;
const CYAN_TILT = 0.18;

// Ink (light mode) only: the comet is pigment on white, and the saturated cyan
// reads too dark there. Mix the drawn colour toward white so it renders as a
// lighter cyan. Dark-mode glow is unaffected.
const INK_LIGHTEN = 0.35;

// Bloom kernel. SIGMA_TAPS is the gaussian sigma measured in TAPS (the shape of
// the 13-tap kernel); SIGMA_CSS drives the physical spacing so the halo is ~2×
// SIGMA_CSS ≈ 20 px across at dpr 1, scaling with dpr for device independence.
const BLUR_SIGMA_TAPS = 2.4;

// The 13-tap kernel's normalized weights, folded to literals at module
// init and baked into the shader source: computing exp() per fragment
// for compile-time constants was ~half a billion redundant
// transcendentals per second at phone fill rates, and mobile GLSL
// compilers are not guaranteed to constant-fold the loop.
const BLUR_WEIGHTS = (() => {
  const raw = Array.from({ length: 7 }, (_, i) =>
    Math.exp((-0.5 * i * i) / (BLUR_SIGMA_TAPS * BLUR_SIGMA_TAPS)),
  );
  const sum = raw[0] + 2 * raw.slice(1).reduce((a, b) => a + b, 0);
  return raw.map((w) => (w / sum).toFixed(6)).join(", ");
})();
const BLUR_SIGMA_CSS = 10.0;

// Composite gains. Ink needs more because a clamped veil alpha is weaker than a
// straight additive add; VEIL_MAX keeps the ink halo from turning into a smear.
const BLOOM_GAIN_GLOW = 1.2;
const BLOOM_GAIN_INK = 1.7;
const VEIL_MAX = 0.5;

// Emissive tint for ink mode: the emissive buffer must encode BRIGHTNESS (so its
// blurred luminance is high where the comet is), but the ink pigment is dark and
// would blur to nothing. So ink renders the emissive pass in white and lets the
// composite tint the resulting halo by `body`.
const WHITE: RGB = [1, 1, 1];

// --- Shader sources (GLSL ES 3.00; explicit attribute locations so VAO setup
//     needs no getAttribLocation round-trips) ---

const RIBBON_VERT = `#version 300 es
layout(location = 0) in vec2 aCenter;   // polyline vertex, CSS px
layout(location = 1) in vec2 aNormal;   // unit screen-space normal
layout(location = 2) in float aS;       // arc length, 0..1
layout(location = 3) in float aSide;    // -1 / +1 strip side
uniform vec2 uResolution;               // device px (full-res drawing buffer)
uniform float uDpr;
uniform float uPhase;
uniform float uWinLen;                  // trail window length in s
uniform float uWTail;                   // width at tail end (CSS px)
uniform float uWHead;                   // width at head end (CSS px)
uniform float uGhost;                   // 1 = ghost (constant width, whole path)
uniform float uAAPad;                   // feather envelope (device px)
out float vU;                           // 0 at tail edge → 1 at head
out float vDist;                        // signed distance from centreline (device px)
out float vRadius;                      // half-width coverage radius (device px)
void main() {
  float u = (aS - (uPhase - uWinLen)) / uWinLen;
  float width = mix(uWTail, uWHead, clamp(u, 0.0, 1.0));
  width = mix(width, uWHead, uGhost);          // ghost overrides to a constant hairline
  float halfW = 0.5 * width * uDpr;
  float off = aSide * (halfW + uAAPad);        // extra pad so the feather isn't clipped
  vec2 posPx = aCenter * uDpr + aNormal * off;
  vec2 ndc = (posPx / uResolution) * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0); // px is y-down, NDC is y-up
  vU = u;
  vDist = off;
  vRadius = halfW;
}`;

const RIBBON_FRAG = `#version 300 es
precision highp float;
in float vU;
in float vDist;
in float vRadius;
uniform vec3 uColor;
uniform float uAlpha;
uniform float uGhost;
uniform float uRoundCap;   // 1 = round the leading tip into a cap, 0 = flat cut
uniform float uWinPx;      // trail window length in device px (maps u → forward px)
out vec4 outColor;
void main() {
  float aa = fwidth(vDist) + 1e-4;                        // screen-space edge softness
  float cov;
  float wa;
  if (uGhost > 0.5) {
    cov = 1.0 - smoothstep(vRadius - aa, vRadius + aa, abs(vDist));
    wa = 1.0;                                             // whole path, flat alpha
  } else if (vU < 0.0) {
    discard;                                              // behind the tail
  } else if (vU > 1.0) {
    // Past the head centreline. The path continues here, so these fragments are
    // free geometry for a round cap: clip them to a circle of radius vRadius
    // centred on the head point. Flat mode just discards them (crisp cut).
    if (uRoundCap < 0.5) discard;
    float fwd = (vU - 1.0) * uWinPx;                      // px ahead of the head
    if (fwd > vRadius + aa) discard;                      // outside the cap
    float rr = length(vec2(vDist, fwd));                  // radial dist from head point
    cov = 1.0 - smoothstep(vRadius - aa, vRadius + aa, rr);
    wa = 1.0;                                             // the head end is full brightness
  } else {
    cov = 1.0 - smoothstep(vRadius - aa, vRadius + aa, abs(vDist));
    wa = smoothstep(0.0, 1.0, vU);                        // eased 0→1 toward the head
  }
  float a = cov * wa * uAlpha;
  if (a <= 0.0) discard;
  outColor = vec4(uColor * a, a);                        // premultiplied
}`;

const HEAD_VERT = `#version 300 es
layout(location = 0) in vec2 aCorner;   // unit quad corner in [-1,1]
uniform vec2 uResolution;
uniform float uDpr;
uniform vec2 uHeadPos;                   // head position, CSS px
uniform float uHeadQuad;                 // quad half-extent, CSS px
out vec2 vCorner;
void main() {
  vec2 posPx = uHeadPos * uDpr + aCorner * uHeadQuad * uDpr;
  vec2 ndc = (posPx / uResolution) * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
  vCorner = aCorner;
}`;

const HEAD_FRAG = `#version 300 es
precision highp float;
in vec2 vCorner;
uniform vec3 uColor;
uniform float uFalloff;
uniform float uIntensity;
out vec4 outColor;
void main() {
  float r2 = dot(vCorner, vCorner);            // 0 at centre → 2 at corner
  float g = exp(-r2 * uFalloff);               // gaussian radial falloff
  float a = clamp(g * uIntensity, 0.0, 1.0);
  if (a <= 0.0) discard;
  outColor = vec4(uColor * a, a);              // premultiplied
}`;

// Full-screen triangle generated from gl_VertexID — no attribute buffer needed.
const FULLSCREEN_VERT = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  vUv = 0.5 * (p + 1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const BLUR_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir;                       // per-tap UV offset (encodes direction + spacing)
out vec4 outColor;
void main() {
  const float W[7] = float[7](${BLUR_WEIGHTS});
  vec4 acc = W[0] * texture(uTex, vUv);
  for (int i = 1; i <= 6; i++) {
    vec2 off = float(i) * uDir;
    acc += W[i] * (texture(uTex, vUv + off) + texture(uTex, vUv - off));
  }
  outColor = acc;
}`;

const COMPOSITE_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;                   // blurred emissive field
uniform float uInk;                       // 1 = ink (veil), 0 = glow (additive)
uniform vec3 uBodyTint;
uniform float uGain;
uniform float uVeilMax;
out vec4 outColor;
void main() {
  vec4 b = texture(uTex, vUv);
  if (uInk > 0.5) {
    float lum = dot(b.rgb, vec3(0.299, 0.587, 0.114));
    float a = clamp(lum * uGain, 0.0, uVeilMax);
    outColor = vec4(uBodyTint * a, a);     // premultiplied veil, drawn source-over
  } else {
    outColor = vec4(b.rgb * uGain, 0.0);   // additive light; alpha untouched
  }
}`;

// --- GL helpers -------------------------------------------------------------

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  src: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createProgram(
  gl: WebGL2RenderingContext,
  vertSrc: string,
  fragSrc: string,
): WebGLProgram | null {
  const vert = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
  if (!vert) return null;
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  if (!frag) {
    gl.deleteShader(vert);
    return null;
  }
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vert);
    gl.deleteShader(frag);
    return null;
  }
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  // Shaders are reference-counted by the program once linked; flag them now.
  gl.deleteShader(vert);
  gl.deleteShader(frag);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
}

// A half-res RGBA8 colour target. RGBA8 is guaranteed colour-renderable and
// linear-filterable in core WebGL2, so this never needs a feature check.
function createTarget(
  gl: WebGL2RenderingContext,
  w: number,
  h: number,
): Target | null {
  const tex = gl.createTexture();
  if (!tex) return null;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  if (!fbo) {
    gl.deleteTexture(tex);
    return null;
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (!complete) {
    gl.deleteTexture(tex);
    gl.deleteFramebuffer(fbo);
    return null;
  }
  return { tex, fbo };
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

// Saturate a colour away from its own luminance (SAT_BOOST), then tilt it toward
// cyan (CYAN_TILT) by suppressing red and lifting green/blue. Applied only to
// the drawn comet (trail + head + bloom tint); the ghost keeps the raw theme
// colour. Clamped to the [0,1] buffer range.
function saturateCyan(c: RGB): RGB {
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const r = l + (c[0] - l) * SAT_BOOST - CYAN_TILT * l;
  const g = l + (c[1] - l) * SAT_BOOST + CYAN_TILT * 0.15 * l;
  const b = l + (c[2] - l) * SAT_BOOST + CYAN_TILT * 0.3 * l;
  return [
    Math.min(Math.max(r, 0), 1),
    Math.min(Math.max(g, 0), 1),
    Math.min(Math.max(b, 0), 1),
  ];
}

// Mix a colour toward white by t ∈ [0,1]. Stays in range for in-range inputs.
function lighten(c: RGB, t: number): RGB {
  return [c[0] + (1 - c[0]) * t, c[1] + (1 - c[1]) * t, c[2] + (1 - c[2]) * t];
}

// Cached uniform locations, one struct per program.

interface RibbonUniforms {
  res: WebGLUniformLocation | null;
  dpr: WebGLUniformLocation | null;
  phase: WebGLUniformLocation | null;
  winLen: WebGLUniformLocation | null;
  wTail: WebGLUniformLocation | null;
  wHead: WebGLUniformLocation | null;
  ghost: WebGLUniformLocation | null;
  aaPad: WebGLUniformLocation | null;
  color: WebGLUniformLocation | null;
  alpha: WebGLUniformLocation | null;
  roundCap: WebGLUniformLocation | null;
  winPx: WebGLUniformLocation | null;
}

interface HeadUniforms {
  res: WebGLUniformLocation | null;
  dpr: WebGLUniformLocation | null;
  pos: WebGLUniformLocation | null;
  quad: WebGLUniformLocation | null;
  color: WebGLUniformLocation | null;
  falloff: WebGLUniformLocation | null;
  intensity: WebGLUniformLocation | null;
}

interface CompositeUniforms {
  ink: WebGLUniformLocation | null;
  tint: WebGLUniformLocation | null;
  gain: WebGLUniformLocation | null;
  veilMax: WebGLUniformLocation | null;
}

// Interleaved ribbon vertex: center(2) + normal(2) + s(1) + side(1).
const RIBBON_STRIDE = 6 * 4;

class TraceRendererImpl implements TraceRenderer {
  private readonly gl: WebGL2RenderingContext;

  private readonly ribbonProgram: WebGLProgram;
  private readonly headProgram: WebGLProgram;
  private readonly blurProgram: WebGLProgram;
  private readonly compositeProgram: WebGLProgram;

  private readonly ribbonU: RibbonUniforms;
  private readonly headU: HeadUniforms;
  private readonly compositeU: CompositeUniforms;
  private readonly blurDirLoc: WebGLUniformLocation | null;

  private readonly ribbonVao: WebGLVertexArrayObject;
  private readonly ribbonVbo: WebGLBuffer;
  private readonly headVao: WebGLVertexArrayObject;
  private readonly headVbo: WebGLBuffer;
  private readonly emptyVao: WebGLVertexArrayObject;

  // Half-res bloom targets, recreated on resize. `emissive` doubles as the
  // final-blur target (the vertical pass writes back into it).
  private emissive: Target | null = null;
  private blur: Target | null = null;

  // Frame geometry / size, updated in resize.
  private devW = 1;
  private devH = 1;
  private halfW = 1;
  private halfH = 1;
  private dpr = 1;
  private blurDirH = 0;
  private blurDirV = 0;

  // Path state, rebuilt in setPath. cumS is normalized arc length per point;
  // pathPts is a private copy so the head lookup is immune to caller mutation.
  private pathPts = new Float32Array(0);
  private cumS = new Float32Array(0);
  private pointCount = 0;
  private vertexCount = 0;
  private pathLenPx = 0; // total arc length in CSS px, for the round-cap forward scale
  private headX = 0;
  private headY = 0;

  private mode: "glow" | "ink" = "glow";
  // Saturated-cyan trail/head colours actually drawn (the raw theme colours are
  // never drawn directly except as the ghost); recomputed in setTheme.
  private bodyCol: RGB = saturateCyan([0.6, 0.8, 1]);
  private headCol: RGB = saturateCyan([1, 1, 1]);
  private ghost: RGB = [0.3, 0.4, 0.6];
  private ghostAlpha = 0.15;

  private destroyed = false;

  constructor(
    gl: WebGL2RenderingContext,
    ribbonProgram: WebGLProgram,
    headProgram: WebGLProgram,
    blurProgram: WebGLProgram,
    compositeProgram: WebGLProgram,
    ribbonVao: WebGLVertexArrayObject,
    ribbonVbo: WebGLBuffer,
    headVao: WebGLVertexArrayObject,
    headVbo: WebGLBuffer,
    emptyVao: WebGLVertexArrayObject,
  ) {
    this.gl = gl;
    this.ribbonProgram = ribbonProgram;
    this.headProgram = headProgram;
    this.blurProgram = blurProgram;
    this.compositeProgram = compositeProgram;
    this.ribbonVao = ribbonVao;
    this.ribbonVbo = ribbonVbo;
    this.headVao = headVao;
    this.headVbo = headVbo;
    this.emptyVao = emptyVao;

    this.ribbonU = {
      res: gl.getUniformLocation(ribbonProgram, "uResolution"),
      dpr: gl.getUniformLocation(ribbonProgram, "uDpr"),
      phase: gl.getUniformLocation(ribbonProgram, "uPhase"),
      winLen: gl.getUniformLocation(ribbonProgram, "uWinLen"),
      wTail: gl.getUniformLocation(ribbonProgram, "uWTail"),
      wHead: gl.getUniformLocation(ribbonProgram, "uWHead"),
      ghost: gl.getUniformLocation(ribbonProgram, "uGhost"),
      aaPad: gl.getUniformLocation(ribbonProgram, "uAAPad"),
      color: gl.getUniformLocation(ribbonProgram, "uColor"),
      alpha: gl.getUniformLocation(ribbonProgram, "uAlpha"),
      roundCap: gl.getUniformLocation(ribbonProgram, "uRoundCap"),
      winPx: gl.getUniformLocation(ribbonProgram, "uWinPx"),
    };
    this.headU = {
      res: gl.getUniformLocation(headProgram, "uResolution"),
      dpr: gl.getUniformLocation(headProgram, "uDpr"),
      pos: gl.getUniformLocation(headProgram, "uHeadPos"),
      quad: gl.getUniformLocation(headProgram, "uHeadQuad"),
      color: gl.getUniformLocation(headProgram, "uColor"),
      falloff: gl.getUniformLocation(headProgram, "uFalloff"),
      intensity: gl.getUniformLocation(headProgram, "uIntensity"),
    };
    this.compositeU = {
      ink: gl.getUniformLocation(compositeProgram, "uInk"),
      tint: gl.getUniformLocation(compositeProgram, "uBodyTint"),
      gain: gl.getUniformLocation(compositeProgram, "uGain"),
      veilMax: gl.getUniformLocation(compositeProgram, "uVeilMax"),
    };
    this.blurDirLoc = gl.getUniformLocation(blurProgram, "uDir");

    // Samplers only ever read from unit 0.
    gl.activeTexture(gl.TEXTURE0);
    gl.useProgram(blurProgram);
    gl.uniform1i(gl.getUniformLocation(blurProgram, "uTex"), 0);
    gl.useProgram(compositeProgram);
    gl.uniform1i(gl.getUniformLocation(compositeProgram, "uTex"), 0);
    gl.useProgram(null);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
  }

  resize(width: number, height: number, dpr: number): void {
    if (this.destroyed) return;
    const gl = this.gl;
    this.dpr = dpr;
    this.devW = Math.max(1, Math.round(width * dpr));
    this.devH = Math.max(1, Math.round(height * dpr));
    this.halfW = Math.max(1, Math.floor(this.devW / 2));
    this.halfH = Math.max(1, Math.floor(this.devH / 2));

    // Per-tap UV spacing so effective sigma ≈ SIGMA_CSS*dpr device px. The /2 is
    // the half-res factor; SIGMA_TAPS converts the CSS sigma into tap units.
    const spacingHalfPx = (BLUR_SIGMA_CSS * dpr) / 2 / BLUR_SIGMA_TAPS;
    this.blurDirH = spacingHalfPx / this.halfW;
    this.blurDirV = spacingHalfPx / this.halfH;

    if (this.emissive) {
      gl.deleteTexture(this.emissive.tex);
      gl.deleteFramebuffer(this.emissive.fbo);
      this.emissive = null;
    }
    if (this.blur) {
      gl.deleteTexture(this.blur.tex);
      gl.deleteFramebuffer(this.blur.fbo);
      this.blur = null;
    }
    this.emissive = createTarget(gl, this.halfW, this.halfH);
    this.blur = createTarget(gl, this.halfW, this.halfH);
  }

  setPath(points: Float32Array): void {
    if (this.destroyed) return;
    const gl = this.gl;
    const n = points.length >> 1;
    if (n < 2) {
      this.pointCount = 0;
      this.vertexCount = 0;
      return;
    }

    // Cumulative arc length → normalized s ∈ [0,1]. Even spacing is assumed but
    // not required; s is measured, not indexed.
    const cum = new Float32Array(n);
    let total = 0;
    for (let i = 1; i < n; i++) {
      const dx = points[2 * i] - points[2 * i - 2];
      const dy = points[2 * i + 1] - points[2 * i - 1];
      total += Math.hypot(dx, dy);
      cum[i] = total;
    }
    const sArr = new Float32Array(n);
    if (total > 0) {
      for (let i = 0; i < n; i++) sArr[i] = cum[i] / total;
    }

    // Per-segment screen-space normals; a zero-length segment reuses the last
    // valid normal so the strip never collapses on a duplicated point.
    const segN = new Float32Array((n - 1) * 2);
    let pnx = 0;
    let pny = 1;
    for (let i = 0; i < n - 1; i++) {
      const dx = points[2 * i + 2] - points[2 * i];
      const dy = points[2 * i + 3] - points[2 * i + 1];
      const len = Math.hypot(dx, dy);
      if (len > 1e-6) {
        pnx = -dy / len;
        pny = dx / len;
      }
      segN[2 * i] = pnx;
      segN[2 * i + 1] = pny;
    }

    // Two vertices per polyline point (±side); interior normals are the averaged
    // adjacent segment normals — the input is smooth, so miter-less is enough.
    const data = new Float32Array(n * 2 * 6);
    let o = 0;
    for (let i = 0; i < n; i++) {
      let nx: number;
      let ny: number;
      if (i === 0) {
        nx = segN[0];
        ny = segN[1];
      } else if (i === n - 1) {
        nx = segN[2 * (n - 2)];
        ny = segN[2 * (n - 2) + 1];
      } else {
        const ax = segN[2 * (i - 1)] + segN[2 * i];
        const ay = segN[2 * (i - 1) + 1] + segN[2 * i + 1];
        const l = Math.hypot(ax, ay);
        if (l > 1e-6) {
          nx = ax / l;
          ny = ay / l;
        } else {
          nx = segN[2 * i];
          ny = segN[2 * i + 1];
        }
      }
      const x = points[2 * i];
      const y = points[2 * i + 1];
      const s = sArr[i];
      data[o++] = x;
      data[o++] = y;
      data[o++] = nx;
      data[o++] = ny;
      data[o++] = s;
      data[o++] = -1;
      data[o++] = x;
      data[o++] = y;
      data[o++] = nx;
      data[o++] = ny;
      data[o++] = s;
      data[o++] = 1;
    }

    gl.bindVertexArray(this.ribbonVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ribbonVbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    this.pathPts = points.slice();
    this.cumS = sArr;
    this.pointCount = n;
    this.vertexCount = n * 2;
    this.pathLenPx = total;
  }

  setTheme(theme: TraceTheme): void {
    if (this.destroyed) return;
    this.mode = theme.mode;
    // In ink mode the drawn colour is pigment on white; lighten it so the cyan
    // reads light rather than a dark saturated ink. Glow keeps the full colour.
    const body = saturateCyan(theme.body);
    const head = saturateCyan(theme.head);
    this.bodyCol = theme.mode === "ink" ? lighten(body, INK_LIGHTEN) : body;
    this.headCol = theme.mode === "ink" ? lighten(head, INK_LIGHTEN) : head;
    this.ghost = [theme.ghost[0], theme.ghost[1], theme.ghost[2]];
    this.ghostAlpha = theme.ghostAlpha;
  }

  render(phase: number): void {
    if (this.destroyed) return;
    const gl = this.gl;

    // Always leave the default framebuffer in a clean transparent state so the
    // page shows through even when there is nothing to draw.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.devW, this.devH);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const emissive = this.emissive;
    const blur = this.blur;
    if (this.pointCount < 2 || !emissive || !blur) return;

    const ink = this.mode === "ink";

    // Head rides the path at min(phase,1); past 1 it fades out ("lands"). The
    // trail keeps advancing on the hidden runway (phase up to 1+WINDOW) so it
    // drains off the far end with no wrap-around to the start.
    this.computeHead(Math.min(phase, 1.0));
    const headFade = 1.0 - smoothstep(LAND_START, LAND_END, phase);

    // --- 1. EMISSIVE PASS (half-res, additive accumulation) ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, emissive.fbo);
    gl.viewport(0, 0, this.halfW, this.halfH);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    const emColor = ink ? WHITE : this.bodyCol;
    this.drawRibbon(phase, false, emColor, TRAIL_ALPHA, WIDTH_TAIL, WIDTH_HEAD);
    // Ink mode has no head "dot": on white it read as a hard blob, and the pale
    // comet wants only its soft trail. Glow keeps the bright point of light.
    if (!ink && headFade > 0) {
      this.drawHead(this.headCol, HEAD_INTENSITY_EMISSIVE * headFade);
    }

    // --- 2. SEPARABLE GAUSSIAN: emissive → blur (H), blur → emissive (V) ---
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.emptyVao);
    gl.useProgram(this.blurProgram);

    gl.bindFramebuffer(gl.FRAMEBUFFER, blur.fbo);
    gl.viewport(0, 0, this.halfW, this.halfH);
    gl.bindTexture(gl.TEXTURE_2D, emissive.tex);
    gl.uniform2f(this.blurDirLoc, this.blurDirH, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, emissive.fbo);
    gl.viewport(0, 0, this.halfW, this.halfH);
    gl.bindTexture(gl.TEXTURE_2D, blur.tex);
    gl.uniform2f(this.blurDirLoc, 0, this.blurDirV);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // emissive.tex now holds the final blurred glow.

    // --- 3/4. ON-SCREEN: ghost (under) → bloom → sharp (over) ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.devW, this.devH);
    gl.enable(gl.BLEND);

    // GHOST: plain source-over hairline, never bloomed, in both modes.
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.drawRibbon(phase, true, this.ghost, this.ghostAlpha, GHOST_WIDTH, GHOST_WIDTH);

    // BLOOM composite: additive light (glow) vs. tinted alpha veil (ink).
    if (ink) {
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    } else {
      gl.blendFunc(gl.ONE, gl.ONE);
    }
    gl.bindVertexArray(this.emptyVao);
    gl.useProgram(this.compositeProgram);
    gl.bindTexture(gl.TEXTURE_2D, emissive.tex);
    gl.uniform1f(this.compositeU.ink, ink ? 1 : 0);
    gl.uniform3f(this.compositeU.tint, this.bodyCol[0], this.bodyCol[1], this.bodyCol[2]);
    gl.uniform1f(this.compositeU.gain, ink ? BLOOM_GAIN_INK : BLOOM_GAIN_GLOW);
    gl.uniform1f(this.compositeU.veilMax, VEIL_MAX);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // SHARP pass: crisp core on top of its own halo.
    if (ink) {
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    } else {
      gl.blendFunc(gl.ONE, gl.ONE);
    }
    this.drawRibbon(phase, false, this.bodyCol, TRAIL_ALPHA, WIDTH_TAIL, WIDTH_HEAD);
    if (!ink && headFade > 0) {
      this.drawHead(this.headCol, HEAD_INTENSITY_SHARP * headFade);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const gl = this.gl;
    gl.deleteProgram(this.ribbonProgram);
    gl.deleteProgram(this.headProgram);
    gl.deleteProgram(this.blurProgram);
    gl.deleteProgram(this.compositeProgram);
    gl.deleteBuffer(this.ribbonVbo);
    gl.deleteBuffer(this.headVbo);
    gl.deleteVertexArray(this.ribbonVao);
    gl.deleteVertexArray(this.headVao);
    gl.deleteVertexArray(this.emptyVao);
    if (this.emissive) {
      gl.deleteTexture(this.emissive.tex);
      gl.deleteFramebuffer(this.emissive.fbo);
      this.emissive = null;
    }
    if (this.blur) {
      gl.deleteTexture(this.blur.tex);
      gl.deleteFramebuffer(this.blur.fbo);
      this.blur = null;
    }
  }

  // Locate the head on the polyline at arc length s via binary search + lerp.
  // Writes headX/headY in place — no allocation, so it is safe per frame.
  private computeHead(s: number): void {
    const n = this.pointCount;
    const cs = this.cumS;
    const pp = this.pathPts;
    if (n < 2) {
      this.headX = 0;
      this.headY = 0;
      return;
    }
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cs[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    if (lo >= n - 1) {
      this.headX = pp[2 * (n - 1)];
      this.headY = pp[2 * (n - 1) + 1];
      return;
    }
    const seg = cs[lo + 1] - cs[lo];
    const t = seg > 1e-9 ? (s - cs[lo]) / seg : 0;
    this.headX = pp[2 * lo] + (pp[2 * lo + 2] - pp[2 * lo]) * t;
    this.headY = pp[2 * lo + 1] + (pp[2 * lo + 3] - pp[2 * lo + 1]) * t;
  }

  private drawRibbon(
    phase: number,
    ghost: boolean,
    color: RGB,
    alpha: number,
    wTail: number,
    wHead: number,
  ): void {
    const gl = this.gl;
    const u = this.ribbonU;
    gl.useProgram(this.ribbonProgram);
    gl.bindVertexArray(this.ribbonVao);
    gl.uniform2f(u.res, this.devW, this.devH);
    gl.uniform1f(u.dpr, this.dpr);
    gl.uniform1f(u.phase, phase);
    gl.uniform1f(u.winLen, TRAIL_WINDOW);
    gl.uniform1f(u.wTail, wTail);
    gl.uniform1f(u.wHead, wHead);
    gl.uniform1f(u.ghost, ghost ? 1 : 0);
    gl.uniform1f(u.aaPad, AA_PAD);
    gl.uniform3f(u.color, color[0], color[1], color[2]);
    gl.uniform1f(u.alpha, alpha);
    // Round cap only on the trail's leading tip (never the ghost's full track).
    gl.uniform1f(u.roundCap, !ghost && ROUND_HEAD ? 1 : 0);
    gl.uniform1f(u.winPx, TRAIL_WINDOW * this.pathLenPx * this.dpr);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, this.vertexCount);
  }

  private drawHead(color: RGB, intensity: number): void {
    const gl = this.gl;
    const u = this.headU;
    gl.useProgram(this.headProgram);
    gl.bindVertexArray(this.headVao);
    gl.uniform2f(u.res, this.devW, this.devH);
    gl.uniform1f(u.dpr, this.dpr);
    gl.uniform2f(u.pos, this.headX, this.headY);
    gl.uniform1f(u.quad, HEAD_QUAD);
    gl.uniform3f(u.color, color[0], color[1], color[2]);
    gl.uniform1f(u.falloff, HEAD_FALLOFF);
    gl.uniform1f(u.intensity, intensity);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

export function createTraceRenderer(
  gl: WebGL2RenderingContext,
): TraceRenderer | null {
  const ribbonProgram = createProgram(gl, RIBBON_VERT, RIBBON_FRAG);
  const headProgram = createProgram(gl, HEAD_VERT, HEAD_FRAG);
  const blurProgram = createProgram(gl, FULLSCREEN_VERT, BLUR_FRAG);
  const compositeProgram = createProgram(gl, FULLSCREEN_VERT, COMPOSITE_FRAG);

  const ribbonVao = gl.createVertexArray();
  const ribbonVbo = gl.createBuffer();
  const headVao = gl.createVertexArray();
  const headVbo = gl.createBuffer();
  const emptyVao = gl.createVertexArray();

  // Any failure here means a required core capability is missing (or the context
  // is lost) — clean up whatever we made and report the miss with null.
  if (
    !ribbonProgram ||
    !headProgram ||
    !blurProgram ||
    !compositeProgram ||
    !ribbonVao ||
    !ribbonVbo ||
    !headVao ||
    !headVbo ||
    !emptyVao
  ) {
    if (ribbonProgram) gl.deleteProgram(ribbonProgram);
    if (headProgram) gl.deleteProgram(headProgram);
    if (blurProgram) gl.deleteProgram(blurProgram);
    if (compositeProgram) gl.deleteProgram(compositeProgram);
    if (ribbonVao) gl.deleteVertexArray(ribbonVao);
    if (ribbonVbo) gl.deleteBuffer(ribbonVbo);
    if (headVao) gl.deleteVertexArray(headVao);
    if (headVbo) gl.deleteBuffer(headVbo);
    if (emptyVao) gl.deleteVertexArray(emptyVao);
    return null;
  }

  // Ribbon VAO: interleaved center/normal/s/side. The buffer stays empty until
  // setPath uploads geometry, but the attribute format lives in the VAO now.
  gl.bindVertexArray(ribbonVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, ribbonVbo);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, RIBBON_STRIDE, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, RIBBON_STRIDE, 8);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 1, gl.FLOAT, false, RIBBON_STRIDE, 16);
  gl.enableVertexAttribArray(3);
  gl.vertexAttribPointer(3, 1, gl.FLOAT, false, RIBBON_STRIDE, 20);

  // Head VAO: a static unit quad drawn as a triangle strip.
  const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
  gl.bindVertexArray(headVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, headVbo);
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  return new TraceRendererImpl(
    gl,
    ribbonProgram,
    headProgram,
    blurProgram,
    compositeProgram,
    ribbonVao,
    ribbonVbo,
    headVao,
    headVbo,
    emptyVao,
  );
}
