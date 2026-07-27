import type { RefObject } from "react";

import type { Fix, Waypoint } from "../../engine/types";
import {
  formatAltitude,
  formatClimb,
  formatCourse,
  formatDistance,
  formatDuration,
  formatRelativeDegrees,
  formatSpeed,
} from "../../flight/format";
import type { Units } from "../../flight/format";
import { bearingBetween, relativeBearing } from "../../flight/nav";
import { haversineMeters } from "../../flight/stats";
import Tile from "./Tile";

import styles from "./FlightSurface.module.css";

/**
 * The in-flight readouts. Eight tiles over the live map, laid out by
 * .instruments (a 2x2-per-row grid in portrait, a single-stack rail in
 * landscape); the ref is how the recording screen measures that box and
 * turns it into map insets.
 */
export default function InstrumentsStrip({
  ref,
  latest,
  first,
  nextWaypoint,
  units,
}: {
  ref: RefObject<HTMLDivElement | null>;
  latest: Fix | null;
  first: Fix | undefined;
  nextWaypoint: Waypoint | null;
  units: Units;
}) {
  // Nav points at the next waypoint whenever a route target remains, and
  // falls back to the launch point once the route is exhausted (nextWaypoint
  // null). Same distance/bearing math either way.
  const navTarget = nextWaypoint ?? first ?? null;
  const navLabel = nextWaypoint ? "waypoint" : "launch";
  const hasTarget = latest !== null && navTarget !== null;
  const toTargetRelative = hasTarget
    ? relativeBearing(latest.course, bearingBetween(latest, navTarget))
    : 0;

  function durationSeconds() {
    if (!latest || !first) return 0;
    return (latest.timestamp - first.timestamp) / 1000;
  }

  function aboveLaunch() {
    if (!latest || !first) return "—";
    return formatAltitude(latest.altitude - first.altitude, units);
  }

  function targetDistance() {
    if (!hasTarget) return "—";
    return formatDistance(haversineMeters(latest, navTarget), units);
  }

  function targetDirection() {
    if (!hasTarget) return "—";
    return formatRelativeDegrees(toTargetRelative);
  }

  function targetArrow() {
    if (!hasTarget) return undefined;
    return (
      <span
        className={styles.launchArrow}
        style={{ rotate: `${toTargetRelative}deg` }}
        aria-hidden="true"
      >
        {/* The same chevron as the map's blue location arrow,
            so "direction to launch" reads as an obvious
            pointer, not a thin glyph. */}
        <svg
          viewBox="-8 -11 16 20"
          className={styles.launchArrowSvg}
          data-testid="launch-arrow-svg"
        >
          <polygon points="0,-10 7,8 0,4 -7,8" />
        </svg>
      </span>
    );
  }

  return (
    <div className={styles.instruments} ref={ref} data-testid="instruments">
      <Tile
        label="Above launch"
        value={aboveLaunch()}
        accent="cyan"
        testId="instrument-agl"
      />
      <Tile
        label="Duration"
        value={formatDuration(durationSeconds())}
        testId="instrument-duration"
      />
      <Tile
        label="Altitude MSL"
        value={latest ? formatAltitude(latest.altitude, units) : "—"}
        testId="instrument-msl"
      />
      <Tile
        label="Climb rate"
        value={latest ? formatClimb(latest.climbRate, units) : "—"}
        testId="instrument-climb"
      />
      <Tile
        label="Ground speed"
        value={latest ? formatSpeed(latest.speed, units) : "—"}
        accent="green"
        testId="instrument-speed"
      />
      <Tile
        label={`Distance to ${navLabel}`}
        value={targetDistance()}
        accent="green"
        testId="instrument-target-distance"
      />
      <Tile
        label="Course"
        value={latest ? formatCourse(latest.course) : "—"}
        icon={latest ? <Compass course={latest.course} /> : undefined}
        accent="yellow"
        testId="instrument-course"
      />
      <Tile
        label={`Direction to ${navLabel}`}
        value={targetDirection()}
        icon={targetArrow()}
        accent="yellow"
        testId="instrument-target-direction"
      />
    </div>
  );
}

function Compass({ course }: { course: number }) {
  return (
    <svg className={styles.compass} viewBox="0 0 44 44" aria-hidden="true">
      <circle cx="22" cy="22" r="20.5" />
      <text x="22" y="8.5">
        N
      </text>
      <text x="36" y="22">
        E
      </text>
      <text x="22" y="35.5">
        S
      </text>
      <text x="8" y="22">
        W
      </text>
      <g transform={`rotate(${course} 22 22)`}>
        <polygon
          className={styles.needleNorth}
          points="22,9 25.5,24 22,21 18.5,24"
        />
        <polygon
          className={styles.needleSouth}
          points="22,35 18.5,20 22,23 25.5,20"
        />
      </g>
    </svg>
  );
}
