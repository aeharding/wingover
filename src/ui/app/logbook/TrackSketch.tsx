import type { Fix } from "../../../engine/types";
import { ACCENT_CYAN } from "../../shared/map/types";

import styles from "./TrackSketch.module.css";

/**
 * The shape a flight drew, on nothing.
 *
 * No map, deliberately. Once the basemap is gone there is nothing left for a
 * map backend to do: no tiles, no GL context, no MapKit token, nothing to
 * fail offline — and no second live map in the seconds right after a landing,
 * when the flight surface has only just released its own. This is one path
 * element.
 *
 * The projection is equirectangular with the longitude scaled by cos(lat).
 * Over one flight that is visually exact, and this is a sketch of a shape
 * rather than a map: nothing is measured off it.
 */
export default function TrackSketch({ track }: { track: Fix[] }) {
  const box = frame(track);
  if (!box) return null;

  return (
    <svg
      className={styles.sketch}
      viewBox={box.viewBox}
      preserveAspectRatio="xMidYMid meet"
      data-testid="track-sketch"
      aria-hidden="true"
    >
      <path
        d={box.d}
        fill="none"
        stroke={ACCENT_CYAN}
        // Constant on screen whatever the flight's aspect ratio: the viewBox
        // stretches to fit, a plain stroke-width would stretch with it.
        vectorEffect="non-scaling-stroke"
        strokeWidth={4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The longer side of every sketch, in viewBox units. Any value works; what
    matters is that it is small and the same for every flight, so precision
    never depends on how far the pilot went. */
const SPAN = 100;

/** null when there is no shape to draw: no fixes, or every fix in one spot. */
function frame(track: Fix[]): { viewBox: string; d: string } | null {
  if (track.length < 2) return null;

  const midLat = (track[0].latitude + track[track.length - 1].latitude) / 2;
  const kx = Math.cos((midLat * Math.PI) / 180);
  // y grows downward, so latitude is negated rather than subtracted from a
  // maximum that is not known until the whole track has been walked.
  const points = track.map((fix): [number, number] => [
    fix.longitude * kx,
    -fix.latitude,
  ]);

  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const width = Math.max(...xs) - minX;
  const height = Math.max(...ys) - minY;
  if (width === 0 && height === 0) return null;

  // Coordinates go in RELATIVE to the flight's own bounds, at a fixed scale,
  // rather than as raw degrees. Degrees put a ~86-wide number in front of an
  // extent that a short flight makes ~0.0003 wide, and rasterizers carry path
  // geometry in single precision: ~7 significant digits against the ~11 that
  // needs, so the line snaps to a staircase. Measured on a 40 m flight — raw
  // degrees came out visibly stepped, this came out smooth.
  const scale = SPAN / Math.max(width, height);
  const at = (value: number, min: number) => ((value - min) * scale).toFixed(2);
  const d = points
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${at(x, minX)} ${at(y, minY)}`)
    .join("");

  // Room for the stroke's own width, which the viewBox knows nothing about.
  const pad = SPAN * 0.06;
  return {
    viewBox: `${-pad} ${-pad} ${width * scale + pad * 2} ${height * scale + pad * 2}`,
    d,
  };
}
