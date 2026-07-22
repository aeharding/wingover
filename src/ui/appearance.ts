/**
 * The pilot's palette preference, and the pure rule that turns it (plus the
 * live system inputs) into a single dark/light decision. Deliberately free of
 * the DOM and storage so the theme wiring (appTheme.ts) and the settings UI
 * share one vocabulary, and the rule stays unit-testable headlessly.
 */

/**
 * "dark" pins the app dark — the DEFAULT, including a fresh install with
 * nothing stored. "auto" restores the system-driven behavior: dark when the
 * OS scheme is dark or the global map view is satellite.
 */
export type Appearance = "dark" | "auto";

/** Unknown / unset reads as the DEFAULT: dark. */
export function normalizeAppearance(value: string | null): Appearance {
  return value === "auto" ? "auto" : "dark";
}

/**
 * Dark when the pilot pinned it, or — in Auto — when the OS scheme is dark or
 * the global map view is satellite (imagery is a dark surface, so the chrome
 * around it goes dark with it, the way Apple Maps does).
 */
export function deriveDark(state: {
  appearance: Appearance;
  systemDark: boolean;
  satellite: boolean;
}): boolean {
  if (state.appearance === "dark") return true;
  return state.systemDark || state.satellite;
}
