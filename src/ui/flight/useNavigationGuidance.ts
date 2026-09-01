import type { EngineSnapshot } from "../../engine/types";
import {
  deriveNavigationGuidance,
  type NavigationGuidance,
  type NavigationTarget,
} from "../../flight/navigationGuidance";

export default function useNavigationGuidance(
  track: EngineSnapshot["track"],
  nextWaypoint: EngineSnapshot["nextWaypoint"],
): NavigationGuidance | null {
  const target = navigationTarget(track[0], nextWaypoint);
  return target ? deriveNavigationGuidance(track, target) : null;
}

function navigationTarget(
  first: EngineSnapshot["track"][number] | undefined,
  nextWaypoint: EngineSnapshot["nextWaypoint"],
): NavigationTarget | null {
  if (nextWaypoint) {
    return {
      kind: "waypoint",
      latitude: nextWaypoint.latitude,
      longitude: nextWaypoint.longitude,
    };
  }
  if (!first) return null;
  return {
    kind: "launch",
    latitude: first.latitude,
    longitude: first.longitude,
  };
}
