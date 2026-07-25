import { invoke } from "@tauri-apps/api/core";

import {
  permissionRefusal,
  type PermissionStatus,
} from "../engine/nativeSource";
import { isTauri } from "./index";

export interface CurrentPosition {
  latitude: number;
  longitude: number;
}

interface NativeFix {
  latitude: number;
  longitude: number;
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
    // ONE refusal rule for both native consumers (nativeSource's
    // permissionRefusal): the watch's pre-capture gate and this one-shot
    // read the same status the same way, so Precise Location off or
    // Location Services off cannot mean one thing to the recorder and
    // another to Center-on-me. This file drifted without that handling.
    const refusal = permissionRefusal(status);
    if (refusal !== null) throw new Error(refusal.message);
    // "prompt" surviving the ask is the pilot dismissing the system alert.
    // permissionRefusal calls that no refusal because the WATCH's answer is
    // to ask again; a one-shot has nobody to ask and CoreLocation would
    // never call back, so it fails here instead of hanging.
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
