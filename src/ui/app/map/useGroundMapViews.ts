import type { MapViewKind } from "../../shared/map/config";
import type { MapView } from "../../shared/map/types";
import useVfrChart from "./useVfrChart";

/**
 * The view cycle a ground map offers: street always, satellite when the
 * backend has imagery to show it with, sectionals once one has actually
 * resolved for this device.
 *
 * Each view earns its place on its own. Charts used to ride the satellite
 * gate, which meant a MapLibre pilot with no MapTiler key was offered no
 * charts either — and, having no toggle at all, no way out of a stored
 * chart view.
 *
 * Charts are a ground-app feature, so this hook and the manifest read
 * behind it live here rather than in shared: the flight surface offers
 * neither the mode nor the network cost of deciding.
 */
export default function useGroundMapViews(map: MapView | null): MapViewKind[] {
  const chart = useVfrChart();
  const views: MapViewKind[] = ["street"];
  if (map?.supportsSatellite) views.push("satellite");
  if (chart) views.push("chart");
  return views;
}
