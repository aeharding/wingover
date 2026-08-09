import type { MapViewKind } from "./config";
import type { MapView } from "./types";
import useVfrChart from "./useVfrChart";

/**
 * The view cycle a map offers: street always, satellite when the backend
 * has imagery to show it with, sectionals once one has resolved for this
 * device.
 *
 * Each view earns its place on its own. Charts used to ride the satellite
 * gate, which meant a MapLibre pilot with no MapTiler key was offered no
 * charts either — and, having no toggle at all, no way out of a stored
 * chart view.
 *
 * Ground and flight get the same answer. A sectional is a navigation
 * chart, and the surface a pilot navigates from is the flight one.
 */
export default function useMapViews(map: MapView | null): MapViewKind[] {
  const chart = useVfrChart();
  const views: MapViewKind[] = ["street"];
  if (map?.supportsSatellite) views.push("satellite");
  if (chart) views.push("chart");
  return views;
}
