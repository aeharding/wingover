import type { RefObject } from "react";

import type { Fix, Waypoint } from "../../engine/types";
import {
  formatAltitude,
  formatArrivalSunsetOffset,
  formatClimb,
  formatCourse,
  formatDuration,
  formatEta,
  formatNavigationDistance,
  formatRelativeDegrees,
  formatSpeed,
  formatSunsetOffset,
} from "../../flight/format";
import type { Units } from "../../flight/format";
import type {
  NavigationGuidance,
  NavigationTargetKind,
} from "../../flight/navigationGuidance";
import { shouldShowNavigationArrival } from "../shared/navigationDisplay";
import Tile, { type TileSecondary } from "./Tile";

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
  guidance,
  units,
}: {
  ref: RefObject<HTMLDivElement | null>;
  latest: Fix | null;
  first: Fix | undefined;
  nextWaypoint: Waypoint | null;
  guidance: NavigationGuidance | null;
  units: Units;
}) {
  // Nav points at the next waypoint whenever a route target remains, and
  // falls back to the launch point once the route is exhausted (nextWaypoint
  // null). Same distance/bearing math either way.
  const targetKind: NavigationTargetKind = nextWaypoint ? "waypoint" : "launch";
  const targetSecondary = targetEtaSecondary(guidance, targetKind);
  const currentSunsetSecondary = sunsetSecondary(guidance);
  const hasSunsetGuidance = Boolean(currentSunsetSecondary);

  function durationSeconds() {
    if (!latest || !first) return 0;
    return (latest.timestamp - first.timestamp) / 1000;
  }

  function aboveLaunch() {
    if (!latest || !first) return "—";
    return formatAltitude(latest.altitude - first.altitude, units);
  }

  function targetDistance() {
    if (!guidance) return "—";
    return formatNavigationDistance(guidance.distanceMeters, units);
  }

  function targetDirection() {
    if (!guidance) return "—";
    return formatRelativeDegrees(guidance.directionDegrees);
  }

  function targetArrow() {
    if (!guidance) return undefined;
    return (
      <span
        className={styles.launchArrow}
        style={{ rotate: `${guidance.directionDegrees}deg` }}
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
    <div
      className={styles.instruments}
      ref={ref}
      data-testid="instruments"
      data-sunset-guidance={hasSunsetGuidance}
    >
      <Tile
        label="Above launch"
        value={aboveLaunch()}
        accent="cyan"
        testId="instrument-agl"
      />
      <Tile
        label="Duration"
        value={formatDuration(durationSeconds())}
        secondary={currentSunsetSecondary}
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
        label={`To ${targetKind}`}
        value={targetDistance()}
        secondary={targetSecondary}
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
        label={`Direction to ${targetKind}`}
        value={targetDirection()}
        icon={targetArrow()}
        accent="yellow"
        testId="instrument-target-direction"
      />
    </div>
  );
}

function sunsetSecondary(
  guidance: NavigationGuidance | null,
): TileSecondary | undefined {
  if (!guidance || guidance.sunsetOffsetMs === null) return undefined;
  return {
    label: "Sunset",
    value: compactSunsetValue(formatSunsetOffset(guidance.sunsetOffsetMs)),
    accent: "magenta",
    testId: "instrument-sunset",
  };
}

function targetEtaSecondary(
  guidance: NavigationGuidance | null,
  targetKind: NavigationTargetKind,
): TileSecondary | undefined {
  if (!shouldShowNavigationArrival(guidance, targetKind)) {
    return undefined;
  }
  if (guidance.arrivalSunsetOffsetMs !== null) {
    return {
      value: compactSunsetValue(
        formatArrivalSunsetOffset(guidance.arrivalSunsetOffsetMs),
      ),
      accent: "magenta",
      testId: "instrument-target-arrival-sunset",
    };
  }
  return {
    value: formatEta(guidance.etaSeconds),
    accent: "green",
    testId: "instrument-target-eta",
  };
}

function compactSunsetValue(value: string) {
  const minusIndex = value.indexOf("−");
  if (minusIndex < 0) return value;
  return (
    <>
      {value.slice(0, minusIndex)}
      <span className={styles.sunsetMinus}>−</span>
      {value.slice(minusIndex + 1)}
    </>
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
