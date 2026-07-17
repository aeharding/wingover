import { useEffect, useState } from "react";

import { isTauri } from "../engine/platform";
import { getBooleanSetting, onSettingChanged } from "../storage/local";
import { launchParam } from "./map/config";

function recordOverride(): boolean {
  if (isTauri() || launchParam("mock-speed") !== null) return true;
  // e2e drives the REAL web engine with stubbed geolocation and needs the
  // Fly tab without the Advanced opt-in dance — same pattern as the
  // "wingover.map" backend override. Doubles as the synchronous mirror of
  // the recordInBrowser setting (written by Settings), so the "/" redirect
  // and the /fly route gate are correct at first render.
  try {
    return localStorage.getItem("wingover.record") === "1";
  } catch {
    return false;
  }
}

/**
 * Whether this build can record a flight. Tauri always (the native engine
 * is the whole point); a browser only via the mock engine (?mock-speed,
 * the dev/e2e seam) or the explicit Advanced opt-in — browsers can stop
 * background recording at any time, so an unqualified Fly tab in a browser
 * would be a promise the platform can't keep (STEERING: PWA recording is
 * best-effort at most). The real audience for the opt-in is Android phone
 * browsers before the native app exists.
 */
export function useCanRecord(): boolean {
  const [canRecord, setCanRecord] = useState(recordOverride);
  useEffect(() => {
    if (recordOverride()) return;
    void getBooleanSetting("recordInBrowser", false).then(
      (on) => on && setCanRecord(true),
    );
    return onSettingChanged("recordInBrowser", (value) =>
      setCanRecord(value === "true"),
    );
  }, []);
  return canRecord;
}
