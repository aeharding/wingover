import { invoke } from "@tauri-apps/api/core";

import { isTauri } from "./platform";

export interface CurrentPosition {
  latitude: number;
  longitude: number;
}

interface NativeFix {
  latitude: number;
  longitude: number;
}

interface PermissionStatus {
  location: "granted" | "denied" | "prompt";
}

// One-shot "where am I" for the map's Center-on-me. Under Tauri it goes
// through the wingover plugin (CoreLocation), NOT navigator.geolocation:
// WKWebView cannot serve web geolocation, so the browser API is a no-op /
// stray "localhost wants your location" prompt on device. In a real
// browser (PWA, dev) navigator.geolocation IS the native API, so that's the
// fallback.
export async function getCurrentPosition(): Promise<CurrentPosition> {
  if (isTauri()) {
    let status = await invoke<PermissionStatus>(
      "plugin:wingover|check_permissions",
    );
    if (status.location === "prompt") {
      status = await invoke<PermissionStatus>(
        "plugin:wingover|request_permissions",
      );
    }
    if (status.location !== "granted") {
      throw new Error(`location permission ${status.location}`);
    }
    const fix = await invoke<NativeFix>("plugin:wingover|current_position");
    return { latitude: fix.latitude, longitude: fix.longitude };
  }

  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      reject(new Error("no geolocation support"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        }),
      (error) => reject(new Error(error.message)),
      { enableHighAccuracy: true },
    );
  });
}
