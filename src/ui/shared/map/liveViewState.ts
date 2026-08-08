import type { MapViewKind } from "./config";

export interface LiveViewState {
  mapView: MapViewKind;
  trackUp: boolean;
  follow: boolean;
  zoom: number;
  center: [number, number];
}

const KEY = "wingover.live-view";

export function readLiveViewState(): Partial<LiveViewState> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Partial<LiveViewState>) : {};
  } catch {
    return {};
  }
}

export function writeLiveViewState(patch: Partial<LiveViewState>) {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({ ...readLiveViewState(), ...patch }),
    );
  } catch {
    return;
  }
}

/**
 * Forget where the camera was left, keeping the preferences (map view,
 * follow, track-up). Arming a flight calls this so the next one arrives at
 * the default zoom instead of inheriting the last flight's; a mid-flight
 * reload never arms, so it still finds the camera the pilot chose.
 */
export function clearLiveViewCamera() {
  try {
    const state = readLiveViewState();
    delete state.zoom;
    delete state.center;
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    return;
  }
}
