import { useSyncExternalStore } from "react";

import { getSetting, onSettingChanged } from "../storage/local";
import { type Appearance, deriveDark, normalizeAppearance } from "./appearance";
import type { MapAppearance } from "./map/config";

/**
 * One source of truth for the app's palette. Dark when the pilot's Appearance
 * preference is "dark" — the DEFAULT, including a fresh install — or, in
 * "auto", when the SYSTEM scheme is dark or the global map view is satellite
 * (imagery is a dark surface, so the chrome around it goes dark with it, the
 * way Apple Maps does). The decision lands as Ionic's `ion-palette-dark`
 * class on <html> (palettes/dark.class.css), which every scheme-aware rule in
 * this app keys off — there are no prefers-color-scheme queries left in
 * styling, so the palette can never disagree with the class.
 *
 * The FLIGHT surface is exempt by construction: its chrome is pinned in
 * FlyPage.css/theme.css and its own map view lives in liveViewState, so
 * neither the class nor the global view reaches it.
 */
const media = window.matchMedia("(prefers-color-scheme: dark)");

// Dark until a stored preference says otherwise (see the async read below).
let appearance: Appearance = "dark";
let satellite = false;
const listeners = new Set<() => void>();

function isDark(): boolean {
  return deriveDark({ appearance, systemDark: media.matches, satellite });
}

function apply() {
  document.documentElement.classList.toggle("ion-palette-dark", isDark());
  listeners.forEach((listener) => listener());
}

/** Called once at app entry, before first render. */
export function initAppTheme() {
  media.addEventListener("change", apply);
  onSettingChanged("appearance", (value) => {
    appearance = normalizeAppearance(value);
    apply();
  });
  onSettingChanged("mapView", (value) => {
    satellite = value === "satellite";
    apply();
  });
  // Stored prefs arrive async. The DEFAULT is dark, so the boot paint is dark
  // and stays dark unless a stored "auto" flips it a beat later — the common
  // path never flashes a light palette. An "auto" pilot on a light OS sees
  // the one-frame dark→light settle, the same trade the satellite flip makes.
  void getSetting("appearance").then((value) => {
    appearance = normalizeAppearance(value);
    apply();
  });
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
 * "light"; STEERING). Flipping the OS theme, toggling satellite, or
 * changing the Appearance setting restyles an open map without a reload.
 */
export function useAppearance(): MapAppearance {
  return useSyncExternalStore(subscribe, () => (isDark() ? "dark" : "light"));
}
