import { useSyncExternalStore } from "react";

import type { MapAppearance } from "./config";

// Ground maps follow the system scheme, live: flipping the OS theme
// restyles an open map without a reload (MapCanvas re-creates the backend
// when `appearance` moves, the same path as a provider swap). The LIVE
// flight map never uses this — it is pinned "light" (full sun is where a
// dark basemap loses; STEERING).
const query = window.matchMedia("(prefers-color-scheme: dark)");

function subscribe(notify: () => void): () => void {
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
}

export default function useSystemAppearance(): MapAppearance {
  return useSyncExternalStore(subscribe, () =>
    query.matches ? "dark" : "light",
  );
}
