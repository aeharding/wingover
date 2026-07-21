import { useSyncExternalStore } from "react";

import { getSetting, onSettingChanged } from "../storage/local";
import type { MapAppearance } from "./map/config";

/**
 * One source of truth for the app's palette. Dark when the SYSTEM scheme
 * is dark, or when the global map view is satellite — imagery is a dark
 * surface, so the chrome around it goes dark with it, the way Apple Maps
 * does. The decision lands as Ionic's `ion-palette-dark` class on <html>
 * (palettes/dark.class.css), which every scheme-aware rule in this app
 * keys off — there are no prefers-color-scheme queries left in styling,
 * so the palette can never disagree with the class.
 *
 * The FLIGHT surface is exempt by construction: its chrome is pinned in
 * FlyPage.css/theme.css and its own map view lives in liveViewState, so
 * neither the class nor the global view reaches it.
 */
const media = window.matchMedia("(prefers-color-scheme: dark)");

let satellite = false;
const listeners = new Set<() => void>();

function isDark(): boolean {
  return media.matches || satellite;
}

function apply() {
  document.documentElement.classList.toggle("ion-palette-dark", isDark());
  listeners.forEach((listener) => listener());
}

/** Called once at app entry, before first render. */
export function initAppTheme() {
  media.addEventListener("change", apply);
  onSettingChanged("mapView", (value) => {
    satellite = value === "satellite";
    apply();
  });
  // The stored view arrives async; until then the system scheme paints
  // (satellite pilots get the dark flip a beat after boot, not a flash of
  // the wrong palette mid-session).
  void getSetting("mapView").then((value) => {
    satellite = value === "satellite";
    apply();
  });
  apply();
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}

/**
 * The effective appearance, live: ground maps pass this to MapCanvas so
 * the basemap matches the chrome (the LIVE flight map stays pinned
 * "light"; STEERING). Flipping the OS theme or toggling satellite
 * restyles an open map without a reload.
 */
export function useAppearance(): MapAppearance {
  return useSyncExternalStore(subscribe, () => (isDark() ? "dark" : "light"));
}
