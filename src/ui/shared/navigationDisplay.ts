import type {
  NavigationGuidance,
  NavigationTargetKind,
} from "../../flight/navigationGuidance";

const ONE_MILE_METERS = 1609.344;
const ONE_MINUTE_SECONDS = 60;

export function shouldShowNavigationArrival(
  guidance: NavigationGuidance | null,
  targetKind: NavigationTargetKind,
): guidance is NavigationGuidance & { etaSeconds: number } {
  if (!guidance || guidance.etaSeconds === null) return false;
  if (guidance.etaSeconds <= ONE_MINUTE_SECONDS) return false;
  return targetKind !== "launch" || guidance.distanceMeters > ONE_MILE_METERS;
}
