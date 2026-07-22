import { useSyncExternalStore } from "react";

/**
 * The desktop breakpoint (Ionic's lg). At and above it the tab bar becomes
 * a left rail and Logbook/Plan gain split panes; below it the app is
 * exactly the phone app. One source of truth shared by the CSS in
 * DesktopShell.module.css — change both together or the layout shears.
 */
const QUERY = "(min-width: 992px)";

const mql = window.matchMedia(QUERY);

function subscribe(listener: () => void): () => void {
  mql.addEventListener("change", listener);
  return () => mql.removeEventListener("change", listener);
}

export function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribe, () => mql.matches);
}
