import type { Fix } from "../../engine/types";

// A flat flight (ground handling, a stubborn vario) still needs a readable
// profile: below this altitude range the chart pads out instead of
// rendering sensor noise as mountains.
export const MIN_RANGE_M = 15;

// 5% headroom above and below so the extremes never kiss the chart edges.
const PAD_FRACTION = 0.05;

export interface BarogramGeometry {
  // Filled region under the profile's top edge.
  area: string;
  // The min/max envelope band, closed (stroke it).
  outline: string;
}

/**
 * Per-CSS-pixel-column min/max altitude over the track, bucketed by TIME
 * (matching the scrubber's linear time axis, and robust to gaps). Min AND
 * max per column so a one-fix altitude spike survives — a per-column
 * average would eat it. Empty columns hold Infinity sentinels.
 */
export function bucketAltitudes(
  track: Fix[],
  cols: number,
): { mins: Float64Array; maxs: Float64Array } {
  const mins = new Float64Array(cols).fill(Infinity);
  const maxs = new Float64Array(cols).fill(-Infinity);
  if (track.length === 0 || cols === 0) return { mins, maxs };
  const t0 = track[0].timestamp;
  const span = Math.max(1, track[track.length - 1].timestamp - t0);
  for (const fix of track) {
    const c = Math.min(
      cols - 1,
      Math.floor(((fix.timestamp - t0) / span) * cols),
    );
    if (fix.altitude < mins[c]) mins[c] = fix.altitude;
    if (fix.altitude > maxs[c]) maxs[c] = fix.altitude;
  }
  return { mins, maxs };
}

/**
 * SVG path strings for the altitude profile at a given pixel size. Pure:
 * (track, width, height) in, path data out — the component just drops the
 * results into <path d>. Fewer than 2 fixes (or a degenerate box) renders
 * nothing.
 */
export function barogramPaths(
  track: Fix[],
  width: number,
  height: number,
): BarogramGeometry {
  if (track.length < 2 || width < 2 || height < 2)
    return { area: "", outline: "" };

  const cols = Math.floor(width);
  const { mins, maxs } = bucketAltitudes(track, cols);

  let lo = Infinity;
  let hi = -Infinity;
  for (let c = 0; c < cols; c++) {
    if (maxs[c] === -Infinity) continue;
    if (mins[c] < lo) lo = mins[c];
    if (maxs[c] > hi) hi = maxs[c];
  }
  if (lo === Infinity) return { area: "", outline: "" };
  if (hi - lo < MIN_RANGE_M) {
    const mid = (hi + lo) / 2;
    lo = mid - MIN_RANGE_M / 2;
    hi = mid + MIN_RANGE_M / 2;
  }
  const pad = (hi - lo) * PAD_FRACTION;
  lo -= pad;
  hi += pad;

  const y = (alt: number) =>
    (height - ((alt - lo) / (hi - lo)) * height).toFixed(1);
  const x = (c: number) => (((c + 0.5) / cols) * width).toFixed(1);

  const top: string[] = [];
  const bottom: string[] = [];
  let firstX = "";
  let lastX = "";
  for (let c = 0; c < cols; c++) {
    if (maxs[c] === -Infinity) continue; // gap: the path spans across it
    const px = x(c);
    if (!firstX) firstX = px;
    lastX = px;
    top.push(`${px} ${y(maxs[c])}`);
    bottom.push(`${px} ${y(mins[c])}`);
  }

  return {
    area: `M${firstX} ${height} L${top.join(" L")} L${lastX} ${height} Z`,
    outline: `M${top.join(" L")} L${bottom.reverse().join(" L")} Z`,
  };
}
