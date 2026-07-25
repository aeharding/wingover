import { isTauri } from "../../engine/platform";
import type { EngineError } from "../../engine/types";

import styles from "./ErrorScreen.module.css";

// Full-screen handling for errors the pilot must ACT on — never inline
// prose on the flight surface. Plain words, one big action, and the
// action opens the app's own iOS Settings page where the fix lives. The
// engine's message strings are diagnostics; this screen owns the
// pilot-facing language.
const CONTENT: Partial<
  Record<EngineError["code"], { title: string; body: string; settings: boolean }>
> = {
  "permission-denied": {
    title: "Location Access Needed",
    body: "Wingover records flights with GPS. Allow location access for Wingover, then come back.",
    settings: true,
  },
  imprecise: {
    title: "Precise Location Is Off",
    body: "Recording a flight needs your exact position. Turn on Precise Location for Wingover, then come back.",
    settings: true,
  },
  busy: {
    title: "Recording Somewhere Else",
    body: "Another tab or window is already recording. Close it there to record here.",
    settings: false,
  },
};

export function actionableError(error: EngineError | null): EngineError | null {
  return error && CONTENT[error.code] ? error : null;
}

function openAppSettings() {
  // The capability scopes opener to this exact URL; iOS routes it to the
  // app's own page in Settings, where both fixes live.
  void import("@tauri-apps/plugin-opener").then(({ openUrl }) =>
    openUrl("app-settings:"),
  );
}

export default function ErrorScreen({
  error,
  onCancel,
}: {
  error: EngineError;
  onCancel?: () => void;
}) {
  const content = CONTENT[error.code];
  if (!content) return null;
  return (
    <div className={styles.screen} data-testid="gps-error">
      <h2>{content.title}</h2>
      <p>{content.body}</p>
      {content.settings && isTauri() && (
        <button className={styles.action} onClick={openAppSettings}>
          Open Settings
        </button>
      )}
      {onCancel && (
        <button className={styles.cancel} onClick={onCancel}>
          Cancel
        </button>
      )}
    </div>
  );
}
