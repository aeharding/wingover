import {
  getSetting,
  onSettingChanged,
  setSetting,
} from "../../../storage/local";
import { resolveBackend } from "../../shared/map/config";

/**
 * Satellite is free on MapKit but needs the pilot's own MapTiler key on
 * MapLibre, so a stored "satellite" can outlive what made it possible: delete
 * the key, or switch to MapLibre, and nothing degrades the view.
 *
 * That state has no way out from the UI. `mapView` still reads "satellite", so
 * appTheme pins the whole app palette dark, while the toggle that would undo it
 * is hidden because supportsSatellite is false without a key. The map draws
 * street in a dark palette and the pilot can change neither.
 */
export async function degradeUnreachableSatellite() {
  if ((await getSetting("mapView")) !== "satellite") return;
  if ((await resolveBackend()) !== "maplibre") return;
  if (await getSetting("maptilerKey")) return;
  await setSetting("mapView", "street");
}

// From boot rather than from the settings screen, so a device already in that
// state recovers on next launch.
export function initSatelliteAvailability() {
  void degradeUnreachableSatellite();
  onSettingChanged("mapBackend", () => void degradeUnreachableSatellite());
  onSettingChanged("maptilerKey", () => void degradeUnreachableSatellite());
}
