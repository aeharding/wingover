import { useEffect, useState } from "react";

import { isTauri } from "../engine/platform";
import { getBooleanSetting, onSettingChanged } from "../storage/local";
import { launchParam } from "./map/config";

// Truly static: never changes within a session.
function staticOverride(): boolean {
  return isTauri() || launchParam("mock-speed") !== null;
}

// The synchronous mirror of the recordInBrowser setting (written by
// Settings; also the e2e override, same pattern as "wingover.map"). It
// makes the "/" redirect and the /fly route gate correct at FIRST render,
// but it is dynamic state, not an override: the live subscription below
// must still run, or turning the toggle OFF never hides Fly.
function mirrored(): boolean {
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
  const [canRecord, setCanRecord] = useState(
    () => staticOverride() || mirrored(),
  );
  useEffect(() => {
    if (staticOverride()) return;
    // OR the mirror: e2e sets only the localStorage flag (no PouchDB
    // setting), and Settings clears both together on turn-off.
    void getBooleanSetting("recordInBrowser", false).then((on) =>
      setCanRecord(on || mirrored()),
    );
    return onSettingChanged("recordInBrowser", (value) =>
      setCanRecord(value === "true" || mirrored()),
    );
  }, []);
  return canRecord;
}
