import type { Fix } from "../../../engine/types";
import {
  formatArrivalSunsetOffset,
  formatCourse,
  formatEta,
  formatRelativeDegrees,
  formatSpeed,
  formatSunsetOffset,
  type Units,
} from "../../../flight/format";
import { bearingBetween } from "../../../flight/nav";
import { deriveNavigationGuidance } from "../../../flight/navigationGuidance";
import {
  estimateAdaptiveReturnSpeed,
  estimateTargetCourseSpeed,
} from "../../../flight/returnSpeed";
import { sunsetNear } from "../../../flight/sun";
import { shouldShowNavigationArrival } from "../../shared/navigationDisplay";

import styles from "./ReplayNavigationDebug.module.css";

export default function ReplayNavigationDebug({
  track,
  units,
}: {
  track: Fix[];
  units: Units;
}) {
  const first = track[0];
  const latest = track[track.length - 1];
  const target = {
    kind: "launch" as const,
    latitude: first.latitude,
    longitude: first.longitude,
  };
  const targetCourse = bearingBetween(latest, target);
  const guidance = deriveNavigationGuidance(track, target);
  const model = estimateAdaptiveReturnSpeed(track, targetCourse);
  const targetSpeed = estimateTargetCourseSpeed(track, targetCourse);
  const rawSunset = sunsetNear(
    new Date(latest.timestamp),
    target.latitude,
    target.longitude,
  )?.getTime();
  const rawSunsetOffset = rawSunset ? latest.timestamp - rawSunset : null;
  const etaSeconds = guidance?.etaSeconds ?? null;
  const rawArrivalOffset =
    rawSunsetOffset !== null && etaSeconds !== null
      ? rawSunsetOffset + etaSeconds * 1000
      : null;
  const selectedSpeed =
    guidance?.etaSeconds && guidance.etaSeconds > 0
      ? guidance.distanceMeters / guidance.etaSeconds
      : null;

  return (
    <div className={styles.panel} data-testid="replay-navigation-debug">
      <div className={styles.title}>RTL debug</div>
      <DebugRow label="UI sunset" value={uiSunset(guidance)} />
      <DebugRow label="UI launch" value={uiTarget(guidance)} />
      <DebugRow
        label="Sunset raw"
        value={formatNullable(rawSunsetOffset, formatSunsetOffset)}
      />
      <DebugRow
        label="Arrival raw"
        value={formatNullable(rawArrivalOffset, formatArrivalSunsetOffset)}
      />
      <DebugRow
        label="ETA exact"
        value={
          etaSeconds === null ? "none" : `${(etaSeconds / 60).toFixed(1)} min`
        }
      />
      <DebugRow
        label="Speed used"
        value={
          selectedSpeed === null ? "none" : formatSpeed(selectedSpeed, units)
        }
      />
      <DebugRow
        label="Model"
        value={
          model
            ? `${formatSpeed(model.conservativeMetersPerSecond, units)} · ${Math.round(model.windowMs / 60_000)}m`
            : "none"
        }
      />
      <DebugRow
        label="Target sample"
        value={
          targetSpeed
            ? `${formatSpeed(targetSpeed.metersPerSecond, units)} · ${Math.round((latest.timestamp - targetSpeed.observedAt) / 1000)}s old`
            : "none"
        }
      />
      <DebugRow
        label="Target handoff"
        value={targetHandoff(targetSpeed, units)}
      />
      <DebugRow
        label="Course / RTL"
        value={`${formatCourse(latest.course)} / ${formatCourse(targetCourse)}`}
      />
      <DebugRow
        label="Error"
        value={
          guidance ? formatRelativeDegrees(guidance.directionDegrees) : "none"
        }
      />
    </div>
  );
}

function DebugRow({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.row}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatNullable(
  value: number | null,
  format: (offsetMs: number) => string,
): string {
  return value === null ? "none" : format(value);
}

function targetHandoff(
  target: ReturnType<typeof estimateTargetCourseSpeed>,
  units: Units,
): string {
  if (!target) return "none";
  const progress = `${Math.round(target.transitionProgress * 100)}%`;
  if (!target.previous) return progress;
  return `${progress} from ${formatSpeed(target.previous.metersPerSecond, units)}`;
}

function uiSunset(
  guidance: ReturnType<typeof deriveNavigationGuidance>,
): string {
  if (!guidance || guidance.sunsetOffsetMs === null) return "hidden";
  return formatSunsetOffset(guidance.sunsetOffsetMs);
}

function uiTarget(
  guidance: ReturnType<typeof deriveNavigationGuidance>,
): string {
  if (!shouldShowNavigationArrival(guidance, "launch")) {
    return "hidden";
  }
  if (guidance.arrivalSunsetOffsetMs !== null) {
    return formatArrivalSunsetOffset(guidance.arrivalSunsetOffsetMs);
  }
  return formatEta(guidance.etaSeconds);
}
