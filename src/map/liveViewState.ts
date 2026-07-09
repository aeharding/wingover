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
