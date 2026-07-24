/**
 * traceRenderer — WebGPU backdrop: a glowing comet retraces the last flight.
 *
 * The effect is the idle-screen wallpaper on FlyPage: a point-headed comet
 * flies launch → landing along the pilot's smoothed track, over a TRANSPARENT
 * canvas so the page background composites behind it (pure black in dark mode,
 * pure white in light mode). Because the same effect has to read on both, the
 * module carries a glow/ink duality baked into how bloom is composited — and
 * ink draws NO head sprite at all (emissive and sharp passes alike): the
 * light-mode comet is deliberately the bare trail.
 *
 * Per-frame pipeline (one command encoder, four render passes; a single
 * clear pass when there is nothing to draw):
 *   1. EMISSIVE PASS → a HALF-resolution offscreen texture. The tapered trail
 *      ribbon and the head sprite are drawn ADDITIVELY into it (blend ONE,ONE),
 *      so overlapping light accumulates and the head clips to a hot core.
 *      Half-res is the first (and cheapest) half of the bloom trick.
 *   2. SEPARABLE GAUSSIAN → two half-res fullscreen passes (horizontal into a
 *      scratch texture, then vertical back into the emissive texture), 13 taps
 *      each. Tap spacing scales with dpr so the *visual* blur radius is device-
 *      independent (~20-24 CSS px). Blurring premultiplied colour is linear, so
 *      no un/re-multiply dance is needed.
 *   3. COMPOSITE the blurred field over the transparent swapchain, in the SAME
 *      on-screen pass as the ghost and sharp draws. Blend state is baked per
 *      pipeline in WebGPU, so the four on-screen draws switch PIPELINES rather
 *      than blendFunc:
 *        - "glow" (dark mode): additive light over pure black IS a real glow,
 *          so we ADD the blurred colour (blend ONE,ONE).
 *        - "ink" (light mode): additive light is invisible on white, so instead
 *          we blend the blur as a normal-alpha VEIL tinted by `body` — alpha =
 *          blurred luminance, clamped so the halo stays subtle. The comet then
 *          reads as saturated pigment with a soft coloured aura.
 *   4. SHARP DRAWS: redraw the crisp trail + head on top of the bloom so the
 *      centre stays a hard point of light inside its own halo.
 *   The GHOST hairline (the whole track) is drawn first, UNDER the bloom, and
 *   is never part of the emissive pass — it is a plain anti-aliased thread.
 *
 * Everything outputs correct PREMULTIPLIED alpha over a (0,0,0,0) clear: the
 * context is configured { alphaMode: "premultiplied" } and the browser
 * composites the canvas over the page. On the spec-guaranteed pure-black page
 * the additive glow's premultiplied RGB IS the final colour; on the white page
 * the ink veil / pigment darkens it.
 *
 * Geometry is tessellated ONCE (in setPath): the polyline becomes a triangle
 * strip carrying screen-space normals and per-vertex arc-length s ∈ [0,1]. All
 * per-frame animation (trail window, taper, head position) is expressed as
 * uniform-buffer values, so a frame is a handful of small writeBuffer() calls +
 * fixed draws — no CPU re-tessellation, no per-frame geometry allocation.
 *
 * HDR duality. When the canvas can be configured extended-range (rgba16float +
 * extended tone mapping) AND the display reports high dynamic range, the head
 * is allowed to burn brighter than SDR white: the EMISSIVE head rides at 2.5×
 * its SDR intensity with its premultiplied RGB left UNCLAMPED (float16 keeps the
 * >1.0 values), so the bloom around the head exceeds 1.0 and the extended-tone-
 * mapped panel displays it above white. The DELIBERATE headroom is the head's
 * alone — ghost, ink mode, and the sharp head core stay SDR-normalised — but
 * note one incidental consequence: the whole emissive buffer is float16 in HDR,
 * so additive TRAIL SELF-OVERLAPS (thermal stacks cross themselves constantly)
 * also accumulate past 1.0 instead of clamping as rgba8unorm did, and glow
 * hotter at the crossings. Bounded in practice (a few strip layers), and
 * arguably truthful — dense maneuvering reads brighter — but it is head +
 * self-overlap, not head alone. With hdr false the whole path is identical to
 * the SDR original (rgba8unorm offscreen, preferred-format swapchain, standard
 * tone map, and the additive clamp behavior included).
 *
 * The hdr flag itself is honest about the DISPLAY, less so about the browser:
 * configure() ignores an unsupported toneMapping member (WebIDL) rather than
 * throwing, so on an HDR display in a browser without extended tone mapping the
 * flag still reads true and the >1.0 head simply clamps to SDR white in the
 * compositor — graceful, but the flag means "we asked and the display could",
 * not "extended tone mapping verified".
 */

// The GPU*Usage / GPUShaderStage bitflag namespaces are value-level globals in
// every WebGPU runtime, but this workspace's TS DOM lib types their *flag*
// fields as `number` without declaring the namespaces themselves. Declare the
// exact subset used here so the flags stay typed (no `any`, no bare magic ints).
declare const GPUBufferUsage: {
  readonly VERTEX: number;
  readonly UNIFORM: number;
  readonly COPY_DST: number;
};
declare const GPUTextureUsage: {
  readonly RENDER_ATTACHMENT: number;
  readonly TEXTURE_BINDING: number;
};
declare const GPUShaderStage: {
  readonly VERTEX: number;
  readonly FRAGMENT: number;
};

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
  // True when the canvas is configured extended-range (rgba16float +
  // toneMapping extended) AND the display reports high dynamic range — i.e.
  // the head is actually allowed to exceed SDR white.
  readonly hdr: boolean;
  // Resolves when the GPUDevice is lost — real loss OR destroy() (reason
  // "destroyed"); the host recreates the renderer. Never rejects.
  readonly lost: Promise<void>;
  // Re-runs context.configure() with the original descriptor. WKWebView can
  // recycle the canvas's compositor layer while the app is backgrounded
  // WITHOUT losing the GPUDevice; the re-created layer does not always carry
  // the extended-range tone mapping back with it, so the HDR head silently
  // returns SDR-clamped. Idempotent and cheap; the host calls it on every
  // visibility resume. Drops the current drawable — repaint after.
  reconfigure(): void;
  resize(width: number, height: number, dpr: number): void; // CSS px + devicePixelRatio
  setPath(points: Float32Array): void; // [x0,y0, x1,y1, ...] in CSS px, ≥2 points, already smoothed/evenly spaced
  setTheme(theme: TraceTheme): void;
  render(phase: number): void; // draws one frame; phase in [0, 1.25)
  destroy(): void; // destroy all GPU resources; renderer unusable after
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

// Ghost "silvering": the hairline gleams where the head's light falls on it,
// like a wire catching lamplight. GAIN multiplies the ghost's alpha at the
// glint peak (base × (1 + GAIN), capped at full coverage in the shader);
// RADIUS is the gaussian sigma in CSS px. The gleam fades with the head's
// landing fade so it dies with the light source.
const SILVER_GAIN = 4.5;
const SILVER_RADIUS = 44;

// Round the leading tip of the trail into a semicircular cap instead of a flat
// cut. Flip to false for a blunt end.
const ROUND_HEAD = true;

// Feather envelope (device px) added on each side of the ribbon so the coverage
// smoothstep has room to fall to zero — a reliable line width is not available,
// so all edges are SDF-feathered in screen space instead.
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

// Bloom kernel. BLUR_SIGMA_TAPS is the gaussian sigma measured in TAPS (the
// shape of the 13-tap kernel); BLUR_SIGMA_CSS drives the physical spacing so the
// halo is ~2× SIGMA_CSS ≈ 20 px across at dpr 1, scaling with dpr for device
// independence.
const BLUR_SIGMA_TAPS = 2.4;
const BLUR_SIGMA_CSS = 10.0;

// The 13-tap kernel's normalized half-weights [w0..w6], folded to literals at
// module init and baked into the WGSL source: computing exp() per fragment for
// compile-time constants was ~half a billion redundant transcendentals per
// second at phone fill rates, and shader compilers are not guaranteed to
// constant-fold the loop.
const BLUR_WEIGHTS: readonly string[] = (() => {
  const raw = Array.from({ length: 7 }, (_, i) =>
    Math.exp((-0.5 * i * i) / (BLUR_SIGMA_TAPS * BLUR_SIGMA_TAPS)),
  );
  const sum = raw[0] + 2 * raw.slice(1).reduce((a, b) => a + b, 0);
  return raw.map((w) => (w / sum).toFixed(6));
})();

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

// HDR headroom, applied ONLY to the emissive head in glow mode when hdr is on.
// The emissive head rides at 2.5× intensity with its RGB effectively unclamped
// (min(e, HDR_HEAD_RGB_MAX); the head's energy peaks ≈ 2.75, so the cap only
// guards float16 range and never actually binds), so its bloom exceeds 1.0 and
// burns above SDR white. SDR uses a clamp max of 1.0, making the emissive head
// output identical to the original.
const HDR_HEAD_BOOST = 2.5;
const HDR_HEAD_RGB_MAX = 64.0;
const SDR_RGB_MAX = 1.0;

// --- WGSL shaders (template-literal constants; struct layouts match the
//     Float32Array uniform stagings below, std140-style 16-byte alignment) ---

// Shared fullscreen-triangle vertex, generated from the vertex index (no vertex
// buffer). uv is V-FLIPPED relative to the WebGL original: WebGPU texture
// coordinates put v=0 at the top row, while the emissive texture is written with
// clip-y-up, so screen-top (clip +1) must sample v=0. Without the flip the bloom
// would composite upside-down relative to the sharp draws.
const FULLSCREEN_VS = `
struct FSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f, }
@vertex fn vs_full(@builtin(vertex_index) vi: u32) -> FSOut {
  let x = select(-1.0, 3.0, vi == 1u);
  let y = select(-1.0, 3.0, vi == 2u);
  let p = vec2f(x, y);
  var out: FSOut;
  out.pos = vec4f(p, 0.0, 1.0);
  out.uv = vec2f(0.5 * (p.x + 1.0), 0.5 * (1.0 - p.y));
  return out;
}`;

const RIBBON_WGSL = `
struct RibbonU {
  resolution: vec2f,   // device px (full-res drawing buffer)
  dpr: f32,
  phase: f32,
  winLen: f32,         // trail window length in s
  wTail: f32,          // width at tail end (CSS px)
  wHead: f32,          // width at head end (CSS px)
  ghost: f32,          // 1 = ghost (constant width, whole path)
  aaPad: f32,          // feather envelope (device px)
  alpha: f32,
  roundCap: f32,       // 1 = round the leading tip into a cap, 0 = flat cut
  winPx: f32,          // trail window length in device px (maps u → forward px)
  color: vec3f,
  silver: f32,         // ghost glint alpha gain near the head; 0 disables
  silverColor: vec3f,  // what the glint tints toward (white in glow, body in ink)
  silverRad: f32,      // glint gaussian sigma (CSS px)
  headPos: vec2f,      // head point (CSS px), for the glint distance
}
@group(0) @binding(0) var<uniform> ru: RibbonU;

struct VIn {
  @location(0) center: vec2f,   // polyline vertex, CSS px
  @location(1) normal: vec2f,   // unit screen-space normal
  @location(2) s: f32,          // arc length, 0..1
  @location(3) side: f32,       // -1 / +1 strip side
}
struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) u: f32,          // 0 at tail edge → 1 at head
  @location(1) dist: f32,       // signed distance from centreline (device px)
  @location(2) radius: f32,     // half-width coverage radius (device px)
  @location(3) wnormal: vec2f,  // wire normal (screen space), for the glint's facing term
}
@vertex fn vs_ribbon(in: VIn) -> VOut {
  let u = (in.s - (ru.phase - ru.winLen)) / ru.winLen;
  var width = mix(ru.wTail, ru.wHead, clamp(u, 0.0, 1.0));
  width = mix(width, ru.wHead, ru.ghost);        // ghost overrides to a constant hairline
  let halfW = 0.5 * width * ru.dpr;
  let off = in.side * (halfW + ru.aaPad);        // extra pad so the feather isn't clipped
  let posPx = in.center * ru.dpr + in.normal * off;
  let ndc = (posPx / ru.resolution) * 2.0 - vec2f(1.0);
  var out: VOut;
  out.pos = vec4f(ndc.x, -ndc.y, 0.0, 1.0);      // px is y-down, clip is y-up
  out.u = u;
  out.dist = off;
  out.radius = halfW;
  out.wnormal = in.normal;
  return out;
}
@fragment fn fs_ribbon(in: VOut) -> @location(0) vec4f {
  let aa = fwidth(in.dist) + 1e-4;               // edge softness (fwidth needs uniform control flow → compute first)
  var cov = 0.0;
  var wa = 0.0;
  if (ru.ghost > 0.5) {
    cov = 1.0 - smoothstep(in.radius - aa, in.radius + aa, abs(in.dist));
    wa = 1.0;                                    // whole path, flat alpha
  } else if (in.u < 0.0) {
    discard;                                      // behind the tail
  } else if (in.u > 1.0) {
    // Past the head centreline. The path continues here, so these fragments are
    // free geometry for a round cap: clip them to a circle of radius in.radius
    // centred on the head point. Flat mode just discards them (crisp cut).
    if (ru.roundCap < 0.5) { discard; }
    let fwd = (in.u - 1.0) * ru.winPx;           // px ahead of the head
    if (fwd > in.radius + aa) { discard; }       // outside the cap
    let rr = length(vec2f(in.dist, fwd));        // radial dist from head point
    cov = 1.0 - smoothstep(in.radius - aa, in.radius + aa, rr);
    wa = 1.0;                                     // the head end is full brightness
  } else {
    cov = 1.0 - smoothstep(in.radius - aa, in.radius + aa, abs(in.dist));
    wa = smoothstep(0.0, 1.0, in.u);             // eased 0→1 toward the head
  }
  var a = cov * wa * ru.alpha;
  var rgb = ru.color;
  if (ru.silver > 0.0) {
    // "Silvering": the hairline itself catches the head's light — brightening
    // and tinting toward silverColor with a gaussian falloff around the head
    // point, distinct from the bloom halo merely passing over it. Alpha is
    // capped at full coverage so the gleam can't over-saturate the wire.
    //
    // The gleam is DIRECTIONAL, like walls under a streetlamp: the wire's
    // face (screen-space normal) catches the light Lambert-style, so a
    // segment passing broadside to the head gleams fully while one running
    // radially away stays near-dark. The Lambert term is SQUARED to sharpen
    // the lobe (oblique walls drop off harder — the accentuated "wall"
    // look), with a small floor keeping a dim scattered-light residual —
    // the wire through the head is itself radial, and the gleam at the
    // source shouldn't vanish entirely.
    let dd = in.pos.xy - ru.headPos * ru.dpr;
    let d = length(dd);
    let lightDir = dd / max(d, 1e-3);
    let n = in.wnormal / max(length(in.wnormal), 1e-3);
    let lam = abs(dot(lightDir, n));
    let facing = mix(0.12, 1.0, lam * lam);
    let sigma = max(ru.silverRad * ru.dpr, 1.0);
    let glint = facing * exp(-0.5 * d * d / (sigma * sigma));
    rgb = mix(rgb, ru.silverColor, 0.85 * glint);
    a = min(a * (1.0 + ru.silver * glint), cov);
  }
  if (a <= 0.0) { discard; }
  return vec4f(rgb * a, a);                      // premultiplied
}`;

const HEAD_WGSL = `
struct HeadU {
  resolution: vec2f,
  headPos: vec2f,      // head position, CSS px
  dpr: f32,
  quad: f32,           // quad half-extent, CSS px
  falloff: f32,
  intensity: f32,
  rgbClampMax: f32,    // 1 = SDR (rgb = color*a); ≫e = HDR (rgb = color*e, may exceed 1)
  color: vec3f,
}
@group(0) @binding(0) var<uniform> hu: HeadU;

struct HOut { @builtin(position) pos: vec4f, @location(0) corner: vec2f, }
@vertex fn vs_head(@builtin(vertex_index) vi: u32) -> HOut {
  // Unit quad corners for a triangle strip: (-1,-1)(1,-1)(-1,1)(1,1).
  let cx = select(-1.0, 1.0, (vi & 1u) != 0u);
  let cy = select(-1.0, 1.0, (vi & 2u) != 0u);
  let corner = vec2f(cx, cy);
  let posPx = hu.headPos * hu.dpr + corner * hu.quad * hu.dpr;
  let ndc = (posPx / hu.resolution) * 2.0 - vec2f(1.0);
  var out: HOut;
  out.pos = vec4f(ndc.x, -ndc.y, 0.0, 1.0);
  out.corner = corner;
  return out;
}
@fragment fn fs_head(@location(0) corner: vec2f) -> @location(0) vec4f {
  let r2 = dot(corner, corner);                  // 0 at centre → 2 at corner
  // Windowed gaussian: the raw tail is still ~1.5% bright where the quad
  // clips it (edge midpoints, r=1), which reads as a faint SQUARE plateau
  // over pure black. Subtracting the r=1 floor (renormalised) zeroes the
  // sprite at the quad's inscribed circle; the core is visually unchanged.
  let gf = exp(-hu.falloff);
  let g = max(exp(-r2 * hu.falloff) - gf, 0.0) / (1.0 - gf);
  let e = g * hu.intensity;
  let a = clamp(e, 0.0, 1.0);
  if (a <= 0.0) { discard; }
  // SDR: rgbClampMax = 1 → rgb = color*min(e,1) = color*a, identical to original.
  // HDR: rgbClampMax ≫ e → rgb = color*e can exceed 1.0 (float16 preserves it).
  let rgb = hu.color * min(e, hu.rgbClampMax);
  return vec4f(rgb, a);                          // premultiplied (emissive: rgb may exceed a)
}`;

const BLUR_TAPS = BLUR_WEIGHTS.map((w, i) =>
  i === 0
    ? `  var acc = ${w} * textureSample(tex, samp, uv);`
    : `  acc += ${w} * (textureSample(tex, samp, uv + ${i}.0 * d) + textureSample(tex, samp, uv - ${i}.0 * d));`,
).join("\n");

const BLUR_WGSL = `
struct BlurU { dir: vec2f, }                     // per-tap UV offset (direction + spacing)
@group(0) @binding(0) var<uniform> bu: BlurU;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;
${FULLSCREEN_VS}
@fragment fn fs_blur(@location(0) uv: vec2f) -> @location(0) vec4f {
  let d = bu.dir;
${BLUR_TAPS}
  return acc;
}`;

const COMPOSITE_WGSL = `
struct CompU { ink: f32, gain: f32, veilMax: f32, bodyTint: vec3f, }
@group(0) @binding(0) var<uniform> cu: CompU;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>; // blurred emissive field
${FULLSCREEN_VS}
@fragment fn fs_composite(@location(0) uv: vec2f) -> @location(0) vec4f {
  let b = textureSample(tex, samp, uv);
  if (cu.ink > 0.5) {
    let lum = dot(b.rgb, vec3f(0.299, 0.587, 0.114));
    let a = clamp(lum * cu.gain, 0.0, cu.veilMax);
    return vec4f(cu.bodyTint * a, a);            // premultiplied veil, drawn source-over
  }
  return vec4f(b.rgb * cu.gain, 0.0);            // additive light; alpha untouched
}`;

// --- Blend states ----------------------------------------------------------

// Additive (ONE, ONE) for colour AND alpha — the emissive accumulation and the
// glow-mode on-screen composite / sharp draws.
const BLEND_ADD: GPUBlendState = {
  color: { srcFactor: "one", dstFactor: "one", operation: "add" },
  alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
};
// Premultiplied source-over (ONE, ONE_MINUS_SRC_ALPHA) — the ghost hairline in
// both modes and every ink-mode on-screen draw.
const BLEND_OVER: GPUBlendState = {
  color: {
    srcFactor: "one",
    dstFactor: "one-minus-src-alpha",
    operation: "add",
  },
  alpha: {
    srcFactor: "one",
    dstFactor: "one-minus-src-alpha",
    operation: "add",
  },
};

const CLEAR: GPUColor = { r: 0, g: 0, b: 0, a: 0 };

// Interleaved ribbon vertex: center(2) + normal(2) + s(1) + side(1) = 24 bytes.
const RIBBON_STRIDE = 24;
const RIBBON_VB_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: RIBBON_STRIDE,
  attributes: [
    { shaderLocation: 0, offset: 0, format: "float32x2" },
    { shaderLocation: 1, offset: 8, format: "float32x2" },
    { shaderLocation: 2, offset: 16, format: "float32" },
    { shaderLocation: 3, offset: 20, format: "float32" },
  ],
};

// Uniform-buffer element counts (Float32 slots) for the shared staging array;
// byte sizes are 4× these. Ribbon pads to 96 B (silvering members), head to
// 64 B, composite to 32 B, blur to 16 B.
const RIBBON_U_FLOATS = 24;
const HEAD_U_FLOATS = 16;
const COMPOSITE_U_FLOATS = 8;
const BLUR_U_FLOATS = 4;

// --- Small colour helpers ---------------------------------------------------

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

// --- Renderer ---------------------------------------------------------------

class TraceRendererImpl implements TraceRenderer {
  readonly hdr: boolean;
  readonly lost: Promise<void>;

  private readonly device: GPUDevice;
  private readonly context: GPUCanvasContext;
  private readonly swapFormat: GPUTextureFormat;
  private readonly offscreenFormat: GPUTextureFormat;

  // Pipelines (built once; formats/blend are fixed for the renderer's life).
  private readonly pRibbonEmissive: GPURenderPipeline; // additive → offscreen
  private readonly pRibbonAddSwap: GPURenderPipeline; // additive → swapchain (glow sharp)
  private readonly pRibbonOverSwap: GPURenderPipeline; // source-over → swapchain (ghost + ink sharp)
  private readonly pHeadEmissive: GPURenderPipeline; // additive → offscreen
  private readonly pHeadAddSwap: GPURenderPipeline; // additive → swapchain (glow sharp head)
  private readonly pBlur: GPURenderPipeline; // replace → offscreen
  private readonly pCompGlow: GPURenderPipeline; // additive → swapchain
  private readonly pCompInk: GPURenderPipeline; // source-over → swapchain

  // Bind-group layouts kept for rebuilding the texture-dependent bind groups.
  private readonly blurBGL: GPUBindGroupLayout;
  private readonly compBGL: GPUBindGroupLayout;
  private readonly sampler: GPUSampler;

  // Uniform buffers — one per distinct draw so multiple draws in one submit each
  // read their own values. Every queue write lands before the command buffer
  // runs, so a single shared buffer would give every draw only the LAST write.
  private readonly ubRibbonEmissive: GPUBuffer;
  private readonly ubRibbonGhost: GPUBuffer;
  private readonly ubRibbonSharp: GPUBuffer;
  private readonly ubHeadEmissive: GPUBuffer;
  private readonly ubHeadSharp: GPUBuffer;
  private readonly ubComposite: GPUBuffer;
  private readonly ubBlurH: GPUBuffer;
  private readonly ubBlurV: GPUBuffer;

  // Uniform-only bind groups (persistent).
  private readonly bgRibbonEmissive: GPUBindGroup;
  private readonly bgRibbonGhost: GPUBindGroup;
  private readonly bgRibbonSharp: GPUBindGroup;
  private readonly bgHeadEmissive: GPUBindGroup;
  private readonly bgHeadSharp: GPUBindGroup;

  // Texture-dependent bind groups, rebuilt on resize.
  private bgBlurH: GPUBindGroup | null = null;
  private bgBlurV: GPUBindGroup | null = null;
  private bgComposite: GPUBindGroup | null = null;

  // Half-res bloom targets, recreated on resize. `emissive` doubles as the
  // final-blur target (the vertical pass writes back into it).
  private emissiveTex: GPUTexture | null = null;
  private emissiveView: GPUTextureView | null = null;
  private blurTex: GPUTexture | null = null;
  private blurView: GPUTextureView | null = null;

  // Ribbon geometry (grow-only buffer, rebuilt in setPath).
  private ribbonVB: GPUBuffer | null = null;
  private ribbonVBSize = 0;

  // One reusable staging array for every uniform write — writeBuffer snapshots
  // its bytes immediately, so refilling it between draws allocates nothing.
  private readonly staging = new Float32Array(RIBBON_U_FLOATS);

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
  private winPxDev = 0; // trail window length in device px (u → forward px)
  private headX = 0;
  private headY = 0;

  private mode: "glow" | "ink" = "glow";
  // Saturated-cyan trail/head colours actually drawn (the raw theme colours are
  // never drawn directly except as the ghost); recomputed in setTheme.
  private bodyCol: RGB = saturateCyan([0.6, 0.8, 1]);
  private headCol: RGB = saturateCyan([1, 1, 1]);
  private ghostCol: RGB = [0.3, 0.4, 0.6];
  private ghostAlpha = 0.15;

  private destroyed = false;

  constructor(
    device: GPUDevice,
    context: GPUCanvasContext,
    hdr: boolean,
    swapFormat: GPUTextureFormat,
    offscreenFormat: GPUTextureFormat,
  ) {
    this.device = device;
    this.context = context;
    this.hdr = hdr;
    this.swapFormat = swapFormat;
    this.offscreenFormat = offscreenFormat;
    // device.lost resolves on real loss AND on device.destroy() (reason
    // "destroyed"); collapse either into a void resolution. It never rejects.
    this.lost = device.lost.then(() => undefined);

    const ribbonModule = device.createShaderModule({ code: RIBBON_WGSL });
    const headModule = device.createShaderModule({ code: HEAD_WGSL });
    const blurModule = device.createShaderModule({ code: BLUR_WGSL });
    const compModule = device.createShaderModule({ code: COMPOSITE_WGSL });

    const uniformBGL = (): GPUBindGroupLayout =>
      device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
            buffer: { type: "uniform" },
          },
        ],
      });
    // Fullscreen samplers (blur/composite) share this shape: uniform + a
    // filtering sampler + a float texture, all fragment-stage.
    const samplerBGL = (): GPUBindGroupLayout =>
      device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.FRAGMENT,
            buffer: { type: "uniform" },
          },
          {
            binding: 1,
            visibility: GPUShaderStage.FRAGMENT,
            sampler: { type: "filtering" },
          },
          {
            binding: 2,
            visibility: GPUShaderStage.FRAGMENT,
            texture: { sampleType: "float" },
          },
        ],
      });

    const ribbonBGL = uniformBGL();
    const headBGL = uniformBGL();
    this.blurBGL = samplerBGL();
    this.compBGL = samplerBGL();

    const layoutFor = (bgl: GPUBindGroupLayout): GPUPipelineLayout =>
      device.createPipelineLayout({ bindGroupLayouts: [bgl] });
    const ribbonPL = layoutFor(ribbonBGL);
    const headPL = layoutFor(headBGL);
    const blurPL = layoutFor(this.blurBGL);
    const compPL = layoutFor(this.compBGL);

    const pipeline = (
      pl: GPUPipelineLayout,
      module: GPUShaderModule,
      vsEntry: string,
      fsEntry: string,
      format: GPUTextureFormat,
      blend: GPUBlendState | undefined,
      topology: GPUPrimitiveTopology,
      buffers: GPUVertexBufferLayout[],
    ): GPURenderPipeline =>
      device.createRenderPipeline({
        layout: pl,
        vertex: { module, entryPoint: vsEntry, buffers },
        fragment: { module, entryPoint: fsEntry, targets: [{ format, blend }] },
        primitive: { topology, cullMode: "none" },
      });

    const ribbonVB = [RIBBON_VB_LAYOUT];
    const noVB: GPUVertexBufferLayout[] = [];
    this.pRibbonEmissive = pipeline(
      ribbonPL,
      ribbonModule,
      "vs_ribbon",
      "fs_ribbon",
      offscreenFormat,
      BLEND_ADD,
      "triangle-strip",
      ribbonVB,
    );
    this.pRibbonAddSwap = pipeline(
      ribbonPL,
      ribbonModule,
      "vs_ribbon",
      "fs_ribbon",
      swapFormat,
      BLEND_ADD,
      "triangle-strip",
      ribbonVB,
    );
    this.pRibbonOverSwap = pipeline(
      ribbonPL,
      ribbonModule,
      "vs_ribbon",
      "fs_ribbon",
      swapFormat,
      BLEND_OVER,
      "triangle-strip",
      ribbonVB,
    );
    this.pHeadEmissive = pipeline(
      headPL,
      headModule,
      "vs_head",
      "fs_head",
      offscreenFormat,
      BLEND_ADD,
      "triangle-strip",
      noVB,
    );
    this.pHeadAddSwap = pipeline(
      headPL,
      headModule,
      "vs_head",
      "fs_head",
      swapFormat,
      BLEND_ADD,
      "triangle-strip",
      noVB,
    );
    this.pBlur = pipeline(
      blurPL,
      blurModule,
      "vs_full",
      "fs_blur",
      offscreenFormat,
      undefined,
      "triangle-list",
      noVB,
    );
    this.pCompGlow = pipeline(
      compPL,
      compModule,
      "vs_full",
      "fs_composite",
      swapFormat,
      BLEND_ADD,
      "triangle-list",
      noVB,
    );
    this.pCompInk = pipeline(
      compPL,
      compModule,
      "vs_full",
      "fs_composite",
      swapFormat,
      BLEND_OVER,
      "triangle-list",
      noVB,
    );

    this.sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    const ub = (floats: number): GPUBuffer =>
      device.createBuffer({
        size: floats * 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    this.ubRibbonEmissive = ub(RIBBON_U_FLOATS);
    this.ubRibbonGhost = ub(RIBBON_U_FLOATS);
    this.ubRibbonSharp = ub(RIBBON_U_FLOATS);
    this.ubHeadEmissive = ub(HEAD_U_FLOATS);
    this.ubHeadSharp = ub(HEAD_U_FLOATS);
    this.ubComposite = ub(COMPOSITE_U_FLOATS);
    this.ubBlurH = ub(BLUR_U_FLOATS);
    this.ubBlurV = ub(BLUR_U_FLOATS);

    const uniformBG = (
      bgl: GPUBindGroupLayout,
      buffer: GPUBuffer,
    ): GPUBindGroup =>
      device.createBindGroup({
        layout: bgl,
        entries: [{ binding: 0, resource: { buffer } }],
      });
    this.bgRibbonEmissive = uniformBG(ribbonBGL, this.ubRibbonEmissive);
    this.bgRibbonGhost = uniformBG(ribbonBGL, this.ubRibbonGhost);
    this.bgRibbonSharp = uniformBG(ribbonBGL, this.ubRibbonSharp);
    this.bgHeadEmissive = uniformBG(headBGL, this.ubHeadEmissive);
    this.bgHeadSharp = uniformBG(headBGL, this.ubHeadSharp);
  }

  // Render-pass descriptors, reused across frames: they were the hot
  // loop's only avoidable garbage (~11 objects/frame). The offscreen
  // ones change only when resize() recreates the views; the on-screen
  // one just gets the rotating swapchain view stamped in before every
  // use. beginRenderPass reads the descriptor synchronously and does
  // not retain it, so mutation-reuse is safe.
  private readonly outAttachment: GPURenderPassColorAttachment = {
    // Stamped with the live swapchain view before every beginRenderPass.
    view: null as unknown as GPUTextureView,
    clearValue: CLEAR,
    loadOp: "clear",
    storeOp: "store",
  };
  private readonly outPassDesc: GPURenderPassDescriptor = {
    colorAttachments: [this.outAttachment],
  };
  private emPassDesc: GPURenderPassDescriptor | null = null;
  private hPassDesc: GPURenderPassDescriptor | null = null;
  private vPassDesc: GPURenderPassDescriptor | null = null;
  private readonly submitBuf: GPUCommandBuffer[] = [];

  reconfigure(): void {
    if (this.destroyed) return;
    // Same descriptor createTraceRenderer settled on: hdr === true implies the
    // extended configuration took AND the display is HDR, so re-asserting
    // extended can't newly fail; the catch is sheer paranoia (a throw here
    // must not take down the visibility handler).
    try {
      this.context.configure({
        device: this.device,
        format: this.swapFormat,
        toneMapping: { mode: this.hdr ? "extended" : "standard" },
        alphaMode: "premultiplied",
        colorSpace: "display-p3",
      });
    } catch {
      /* keep whatever configuration the layer still has */
    }
  }

  resize(width: number, height: number, dpr: number): void {
    if (this.destroyed) return;
    const device = this.device;
    this.dpr = dpr;
    this.devW = Math.max(1, Math.round(width * dpr));
    this.devH = Math.max(1, Math.round(height * dpr));
    this.halfW = Math.max(1, Math.floor(this.devW / 2));
    this.halfH = Math.max(1, Math.floor(this.devH / 2));
    this.winPxDev = TRAIL_WINDOW * this.pathLenPx * this.dpr;

    // Per-tap UV spacing so effective sigma ≈ SIGMA_CSS*dpr device px. The /2 is
    // the half-res factor; SIGMA_TAPS converts the CSS sigma into tap units.
    const spacingHalfPx = (BLUR_SIGMA_CSS * dpr) / 2 / BLUR_SIGMA_TAPS;
    this.blurDirH = spacingHalfPx / this.halfW;
    this.blurDirV = spacingHalfPx / this.halfH;

    this.emissiveTex?.destroy();
    this.blurTex?.destroy();
    // rgba16float (HDR) is renderable + blendable + filterable in core WebGPU,
    // as is rgba8unorm (SDR) — neither needs a device feature.
    const target = (): { tex: GPUTexture; view: GPUTextureView } => {
      const tex = device.createTexture({
        size: { width: this.halfW, height: this.halfH },
        format: this.offscreenFormat,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      return { tex, view: tex.createView() };
    };
    const em = target();
    const bl = target();
    this.emissiveTex = em.tex;
    this.emissiveView = em.view;
    this.blurTex = bl.tex;
    this.blurView = bl.view;

    // Blur H reads emissive → writes blur; blur V reads blur → writes emissive.
    // Composite reads the final emissive (post-V) field.
    const texBG = (uniform: GPUBuffer, view: GPUTextureView): GPUBindGroup =>
      device.createBindGroup({
        layout: this.blurBGL,
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: view },
        ],
      });
    this.bgBlurH = texBG(this.ubBlurH, this.emissiveView);
    this.bgBlurV = texBG(this.ubBlurV, this.blurView);
    this.bgComposite = device.createBindGroup({
      layout: this.compBGL,
      entries: [
        { binding: 0, resource: { buffer: this.ubComposite } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: this.emissiveView },
      ],
    });

    // Blur directions only change on resize; write them here, not per frame.
    const s = this.staging;
    s[0] = this.blurDirH;
    s[1] = 0;
    s[2] = 0;
    s[3] = 0;
    device.queue.writeBuffer(this.ubBlurH, 0, s, 0, BLUR_U_FLOATS);
    s[0] = 0;
    s[1] = this.blurDirV;
    device.queue.writeBuffer(this.ubBlurV, 0, s, 0, BLUR_U_FLOATS);

    // The offscreen pass descriptors follow the recreated views.
    const offscreen = (view: GPUTextureView): GPURenderPassDescriptor => ({
      colorAttachments: [
        { view, clearValue: CLEAR, loadOp: "clear", storeOp: "store" },
      ],
    });
    this.emPassDesc = offscreen(this.emissiveView);
    this.hPassDesc = offscreen(this.blurView);
    this.vPassDesc = offscreen(this.emissiveView);
  }

  setPath(points: Float32Array): void {
    if (this.destroyed) return;
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

    // Grow-only: the track's point count is stable across resizes, so the buffer
    // is allocated once and only reuploaded — never reallocated per fit().
    const bytes = data.byteLength;
    if (!this.ribbonVB || this.ribbonVBSize < bytes) {
      this.ribbonVB?.destroy();
      this.ribbonVB = this.device.createBuffer({
        size: bytes,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.ribbonVBSize = bytes;
    }
    this.device.queue.writeBuffer(this.ribbonVB, 0, data, 0, data.length);

    this.pathPts = points.slice();
    this.cumS = sArr;
    this.pointCount = n;
    this.vertexCount = n * 2;
    this.pathLenPx = total;
    this.winPxDev = TRAIL_WINDOW * this.pathLenPx * this.dpr;
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
    this.ghostCol = [theme.ghost[0], theme.ghost[1], theme.ghost[2]];
    this.ghostAlpha = theme.ghostAlpha;

    // Composite uniforms depend only on theme (not phase); upload them here.
    const ink = theme.mode === "ink";
    const s = this.staging;
    s[0] = ink ? 1 : 0;
    s[1] = ink ? BLOOM_GAIN_INK : BLOOM_GAIN_GLOW;
    s[2] = VEIL_MAX;
    s[3] = 0;
    s[4] = this.bodyCol[0];
    s[5] = this.bodyCol[1];
    s[6] = this.bodyCol[2];
    s[7] = 0;
    this.device.queue.writeBuffer(
      this.ubComposite,
      0,
      s,
      0,
      COMPOSITE_U_FLOATS,
    );
  }

  render(phase: number): void {
    if (this.destroyed) return;
    const device = this.device;
    const encoder = device.createCommandEncoder();
    // getCurrentTexture() must be called every frame to advance the swapchain;
    // its view is the one unavoidable per-frame allocation (the texture rotates).
    const swapView = this.context.getCurrentTexture().createView();

    const emPassDesc = this.emPassDesc;
    const hPassDesc = this.hPassDesc;
    const vPassDesc = this.vPassDesc;
    const bgBlurH = this.bgBlurH;
    const bgBlurV = this.bgBlurV;
    const bgComposite = this.bgComposite;
    const ribbonVB = this.ribbonVB;
    this.outAttachment.view = swapView;

    // Nothing to draw yet (no path, or not yet resized): still present a clean
    // transparent frame so the page shows through.
    if (
      this.pointCount < 2 ||
      !emPassDesc ||
      !hPassDesc ||
      !vPassDesc ||
      !bgBlurH ||
      !bgBlurV ||
      !bgComposite ||
      !ribbonVB
    ) {
      const pass = encoder.beginRenderPass(this.outPassDesc);
      pass.end();
      this.submitBuf[0] = encoder.finish();
      device.queue.submit(this.submitBuf);
      return;
    }

    const ink = this.mode === "ink";

    // Head rides the path at min(phase,1); past 1 it fades out ("lands"). The
    // trail keeps advancing on the hidden runway (phase up to 1+WINDOW) so it
    // drains off the far end with no wrap-around to the start.
    this.computeHead(Math.min(phase, 1.0));
    const headFade = 1.0 - smoothstep(LAND_START, LAND_END, phase);
    const drawHead = !ink && headFade > 0;

    // --- Uniform writes (all land on the queue before the command buffer runs) ---
    const emColor = ink ? WHITE : this.bodyCol;
    this.writeRibbonU(
      this.ubRibbonEmissive,
      0,
      emColor,
      TRAIL_ALPHA,
      WIDTH_TAIL,
      WIDTH_HEAD,
      ROUND_HEAD ? 1 : 0,
      phase,
    );
    // The silvering is a DARK-mode effect only: light mode is daytime, and
    // daylight has no flashlight to catch on the track (per Alex; the cyan
    // gleam on white just read as a smudge).
    this.writeRibbonU(
      this.ubRibbonGhost,
      1,
      this.ghostCol,
      this.ghostAlpha,
      GHOST_WIDTH,
      GHOST_WIDTH,
      0,
      phase,
      ink ? 0 : SILVER_GAIN * headFade,
    );
    this.writeRibbonU(
      this.ubRibbonSharp,
      0,
      this.bodyCol,
      TRAIL_ALPHA,
      WIDTH_TAIL,
      WIDTH_HEAD,
      ROUND_HEAD ? 1 : 0,
      phase,
    );
    if (drawHead) {
      // Only the head gets HDR headroom: 2.5× emissive intensity + unclamped RGB
      // so its bloom exceeds 1.0 and burns above SDR white on an HDR panel.
      const emBoost = this.hdr ? HDR_HEAD_BOOST : 1;
      const emClamp = this.hdr ? HDR_HEAD_RGB_MAX : SDR_RGB_MAX;
      this.writeHeadU(
        this.ubHeadEmissive,
        this.headCol,
        HEAD_INTENSITY_EMISSIVE * headFade * emBoost,
        emClamp,
      );
      // The sharp core stays SDR-normalised (clamped); the head burns via bloom.
      this.writeHeadU(
        this.ubHeadSharp,
        this.headCol,
        HEAD_INTENSITY_SHARP * headFade,
        SDR_RGB_MAX,
      );
    }

    // --- 1. EMISSIVE PASS (half-res, additive accumulation) ---
    const emPass = encoder.beginRenderPass(emPassDesc);
    emPass.setPipeline(this.pRibbonEmissive);
    emPass.setBindGroup(0, this.bgRibbonEmissive);
    emPass.setVertexBuffer(0, ribbonVB);
    emPass.draw(this.vertexCount);
    // Ink mode has no head "dot": on white it read as a hard blob, and the pale
    // comet wants only its soft trail. Glow keeps the bright point of light.
    if (drawHead) {
      emPass.setPipeline(this.pHeadEmissive);
      emPass.setBindGroup(0, this.bgHeadEmissive);
      emPass.draw(4);
    }
    emPass.end();

    // --- 2. SEPARABLE GAUSSIAN: emissive → blur (H), blur → emissive (V) ---
    const hPass = encoder.beginRenderPass(hPassDesc);
    hPass.setPipeline(this.pBlur);
    hPass.setBindGroup(0, bgBlurH);
    hPass.draw(3);
    hPass.end();

    const vPass = encoder.beginRenderPass(vPassDesc);
    vPass.setPipeline(this.pBlur);
    vPass.setBindGroup(0, bgBlurV);
    vPass.draw(3);
    vPass.end();
    // emissiveView now holds the final blurred glow (sampled by the composite).

    // --- 3/4. ON-SCREEN: ghost (under) → bloom → sharp (over) ---
    const outPass = encoder.beginRenderPass(this.outPassDesc);

    // GHOST: plain source-over hairline, never bloomed, in both modes.
    outPass.setPipeline(this.pRibbonOverSwap);
    outPass.setBindGroup(0, this.bgRibbonGhost);
    outPass.setVertexBuffer(0, ribbonVB);
    outPass.draw(this.vertexCount);

    // BLOOM composite: additive light (glow) vs. tinted alpha veil (ink).
    outPass.setPipeline(ink ? this.pCompInk : this.pCompGlow);
    outPass.setBindGroup(0, bgComposite);
    outPass.draw(3);

    // SHARP trail: crisp ribbon on top of its own halo.
    outPass.setPipeline(ink ? this.pRibbonOverSwap : this.pRibbonAddSwap);
    outPass.setBindGroup(0, this.bgRibbonSharp);
    outPass.setVertexBuffer(0, ribbonVB);
    outPass.draw(this.vertexCount);

    // SHARP head: hard point of light (glow only).
    if (drawHead) {
      outPass.setPipeline(this.pHeadAddSwap);
      outPass.setBindGroup(0, this.bgHeadSharp);
      outPass.draw(4);
    }
    outPass.end();

    this.submitBuf[0] = encoder.finish();
    device.queue.submit(this.submitBuf);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emissiveTex?.destroy();
    this.blurTex?.destroy();
    this.ribbonVB?.destroy();
    this.ubRibbonEmissive.destroy();
    this.ubRibbonGhost.destroy();
    this.ubRibbonSharp.destroy();
    this.ubHeadEmissive.destroy();
    this.ubHeadSharp.destroy();
    this.ubComposite.destroy();
    this.ubBlurH.destroy();
    this.ubBlurV.destroy();
    // Frees remaining GPU objects (pipelines, bind groups, sampler) and resolves
    // device.lost (reason "destroyed"), which in turn fulfils this.lost.
    this.device.destroy();
  }

  // Fill the shared staging array for a ribbon draw and upload it. Static fields
  // (resolution, dpr, winLen, aaPad, winPx) come from instance state; only phase
  // and the per-draw colour/width/ghost differ.
  private writeRibbonU(
    buf: GPUBuffer,
    ghost: number,
    color: RGB,
    alpha: number,
    wTail: number,
    wHead: number,
    roundCap: number,
    phase: number,
    silver = 0,
    silverColor: RGB = WHITE,
  ): void {
    const s = this.staging;
    s[0] = this.devW;
    s[1] = this.devH;
    s[2] = this.dpr;
    s[3] = phase;
    s[4] = TRAIL_WINDOW;
    s[5] = wTail;
    s[6] = wHead;
    s[7] = ghost;
    s[8] = AA_PAD;
    s[9] = alpha;
    s[10] = roundCap;
    s[11] = this.winPxDev;
    s[12] = color[0];
    s[13] = color[1];
    s[14] = color[2];
    s[15] = silver;
    s[16] = silverColor[0];
    s[17] = silverColor[1];
    s[18] = silverColor[2];
    s[19] = SILVER_RADIUS;
    s[20] = this.headX;
    s[21] = this.headY;
    s[22] = 0;
    s[23] = 0;
    this.device.queue.writeBuffer(buf, 0, s, 0, RIBBON_U_FLOATS);
  }

  private writeHeadU(
    buf: GPUBuffer,
    color: RGB,
    intensity: number,
    rgbClampMax: number,
  ): void {
    const s = this.staging;
    s[0] = this.devW;
    s[1] = this.devH;
    s[2] = this.headX;
    s[3] = this.headY;
    s[4] = this.dpr;
    s[5] = HEAD_QUAD;
    s[6] = HEAD_FALLOFF;
    s[7] = intensity;
    s[8] = rgbClampMax;
    s[9] = 0;
    s[10] = 0;
    s[11] = 0;
    s[12] = color[0];
    s[13] = color[1];
    s[14] = color[2];
    s[15] = 0;
    this.device.queue.writeBuffer(buf, 0, s, 0, HEAD_U_FLOATS);
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
}

// Full WebGPU bring-up. Returns null (never throws) when any step is
// unavailable: no navigator.gpu, no adapter/device, or no canvas context.
export async function createTraceRenderer(
  canvas: HTMLCanvasElement,
): Promise<TraceRenderer | null> {
  if (typeof navigator === "undefined" || !navigator.gpu) return null;

  let adapter: GPUAdapter | null;
  try {
    adapter = await navigator.gpu.requestAdapter({
      powerPreference: "high-performance",
    });
  } catch {
    return null;
  }
  if (!adapter) return null;

  let device: GPUDevice;
  try {
    device = await adapter.requestDevice();
  } catch {
    return null;
  }

  // No typed getContext("webgpu") overload in this workspace's DOM lib, so the
  // string overload yields RenderingContext | null; assert the real type.
  const context = canvas.getContext(
    "webgpu",
  ) as unknown as GPUCanvasContext | null;
  if (!context) {
    device.destroy();
    return null;
  }

  // HDR gating. Try extended-range first; the head may exceed SDR white only
  // when that succeeds AND the display reports high dynamic range. Otherwise
  // fall back to a standard-tone-mapped preferred-format swapchain, where the
  // whole path renders identically to the SDR original.
  const dynamicRangeHigh =
    typeof matchMedia === "function" &&
    matchMedia("(dynamic-range: high)").matches;

  let extendedConfigured: boolean;
  try {
    context.configure({
      device,
      format: "rgba16float",
      toneMapping: { mode: "extended" },
      alphaMode: "premultiplied",
      colorSpace: "display-p3",
    });
    extendedConfigured = true;
  } catch {
    extendedConfigured = false;
  }

  const hdr = extendedConfigured && dynamicRangeHigh;
  let swapFormat: GPUTextureFormat;
  if (hdr) {
    swapFormat = "rgba16float";
  } else {
    // Reconfigure standard when extended failed OR the display isn't HDR (an
    // extended config we don't need is replaced so the scene stays SDR-normal).
    swapFormat = navigator.gpu.getPreferredCanvasFormat();
    try {
      context.configure({
        device,
        format: swapFormat,
        toneMapping: { mode: "standard" },
        alphaMode: "premultiplied",
        colorSpace: "display-p3",
      });
    } catch {
      device.destroy();
      return null;
    }
  }

  // Offscreen bloom targets match the configured range: float16 to carry the
  // head's >1.0 emissive energy in HDR, plain 8-bit otherwise.
  const offscreenFormat: GPUTextureFormat = hdr ? "rgba16float" : "rgba8unorm";

  return new TraceRendererImpl(
    device,
    context,
    hdr,
    swapFormat,
    offscreenFormat,
  );
}
