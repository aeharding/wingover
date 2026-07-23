import type { Fix } from "../../engine/types";

type XY = [number, number];

// Even spacing along the polyline, not along time: a stride over fixes
// clusters points where the flight was slow, and uneven spacing is what
// makes smoothing kink and overshoot.
function resample(pts: XY[], count: number): XY[] {
  const lengths = [0];
  for (let i = 1; i < pts.length; i++) {
    lengths.push(
      lengths[i - 1] +
        Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]),
    );
  }
  const total = lengths[lengths.length - 1];
  const out: XY[] = [pts[0]];
  let seg = 1;
  for (let n = 1; n < count - 1; n++) {
    const target = (total * n) / (count - 1);
    while (lengths[seg] < target) seg++;
    // A zero-length segment (duplicated point) would make this 0/0; the
    // pinned t keeps NaN out of the ribbon.
    const span = lengths[seg] - lengths[seg - 1];
    const t = span > 0 ? (target - lengths[seg - 1]) / span : 0;
    out.push([
      pts[seg - 1][0] + (pts[seg][0] - pts[seg - 1][0]) * t,
      pts[seg - 1][1] + (pts[seg][1] - pts[seg - 1][1]) * t,
    ]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// A gentle box blur over neighbors, endpoints pinned: kills the GPS
// jitter the resample can't, without pulling the shape off the flight.
function relax(pts: XY[], passes: number): XY[] {
  let out = pts;
  for (let pass = 0; pass < passes; pass++) {
    out = out.map((p, i) =>
      i === 0 || i === out.length - 1
        ? p
        : [
            (out[i - 1][0] + p[0] * 2 + out[i + 1][0]) / 4,
            (out[i - 1][1] + p[1] * 2 + out[i + 1][1]) / 4,
          ],
    );
  }
  return out;
}

// The frame the flight is fitted into, in CSS px of the actual element:
// clear of the large-title band above, edge padding at the sides, and
// deliberately reaching toward the bottom edge — the element's box spans
// under the translucent tab bar, so a southern track rides under glass.
const PAD_X = 28;
const PAD_TOP = 150;
const PAD_BOTTOM = 18;

/**
 * The last flight projected into PIXEL space for the given element size.
 * Equirectangular with a cos(midLat) x-correction is exact enough at
 * flight scale; the fit is north-up, evenly resampled (point density
 * scales with on-screen length, so a big desktop host gets more curve),
 * and relaxed. Rendering in px is what keeps stroke widths fixed on any
 * viewport. Returns null when the geometry wouldn't read as a flight (a
 * point, a parked GPS) or the box is too small to draw in.
 */
export function projectTrack(
  fixes: Fix[],
  width: number,
  height: number,
): Float32Array | null {
  if (fixes.length < 2) return null;
  const fitW = width - PAD_X * 2;
  const fitH = height - PAD_TOP - PAD_BOTTOM;
  if (fitW < 40 || fitH < 40) return null;

  // Cap the projection work on pathological tracks; the resample below
  // owns the real point budget.
  const stride = Math.max(1, Math.floor(fixes.length / 2000));
  const sampled = fixes.filter((_, i) => i % stride === 0);
  const last = fixes[fixes.length - 1];
  if (sampled[sampled.length - 1] !== last) sampled.push(last);

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const p of sampled) {
    minLat = Math.min(minLat, p.latitude);
    maxLat = Math.max(maxLat, p.latitude);
    minLng = Math.min(minLng, p.longitude);
    maxLng = Math.max(maxLng, p.longitude);
  }
  const kx = Math.cos(((minLat + maxLat) / 2) * (Math.PI / 180));
  const w = (maxLng - minLng) * kx;
  const h = maxLat - minLat;
  // Under ~10 m of extent both ways it's a dot, not a flight.
  if (w < 1e-4 && h < 1e-4) return null;

  const scale = Math.min(fitW / w, fitH / h);
  const left = PAD_X + (fitW - w * scale) / 2;
  // Vertical slack splits 30/70, not 50/50: a wide-flat track dead-center
  // hides behind the Start pill; in the upper third it owns the empty
  // sky. A height-filling track has no slack to split.
  const top = PAD_TOP + (fitH - h * scale) * 0.3;
  const projected: XY[] = sampled.map((p) => [
    left + (p.longitude - minLng) * kx * scale,
    top + (maxLat - p.latitude) * scale,
  ]);

  // Point density follows on-screen length so joins stay invisible at
  // any host size, within sane bounds.
  let lengthPx = 0;
  for (let i = 1; i < projected.length; i++) {
    lengthPx += Math.hypot(
      projected[i][0] - projected[i - 1][0],
      projected[i][1] - projected[i - 1][1],
    );
  }
  const count = Math.min(256, Math.max(90, Math.round(lengthPx / 8)));

  const smoothed = relax(resample(projected, count), 2);
  const out = new Float32Array(smoothed.length * 2);
  smoothed.forEach(([x, y], i) => {
    out[i * 2] = x;
    out[i * 2 + 1] = y;
  });
  return out;
}
