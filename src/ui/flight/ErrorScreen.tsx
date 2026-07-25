import { useState } from "react";

import { isTauri } from "../../engine/platform";
import type { BlockingError, BlockingErrorCode } from "../../engine/types";
import { cx } from "../cx";
import { openExternal } from "../externalLinks";

import styles from "./ErrorScreen.module.css";

// Full-screen handling for the engine's "blocked" status — errors the
// pilot must ACT on, never inline prose. Plain words, one big action;
// Open Settings deep-links the app's own iOS Settings page where both
// location fixes live. The engine's message strings are diagnostics;
// this screen owns the pilot-facing language. Total over
// BlockingErrorCode: a new blocking class fails the build until it gets
// copy here.
const CONTENT: Record<
  BlockingErrorCode,
  { title: string; body: string; settings: boolean }
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

// The web has no app Settings page to deep-link, and a browser that
// remembered a denial will NOT re-prompt: a bare retry comes straight
// back blocked. The copy must point at where the unblock actually
// lives, or Try Again reads as broken.
const WEB_BODY: Partial<Record<BlockingErrorCode, string>> = {
  "permission-denied":
    "Your browser is blocking location for this site and will not ask again. In Safari, tap the menu in the address bar, open Website Settings, and allow Location; then try again.",
  imprecise:
    "Fixes are kilometers coarse; recording needs your exact position. On iPhone: Settings, Privacy, Location Services, Safari Websites; turn on Precise Location, then come back.",
};

// The capability scopes opener to this exact URL; iOS routes it to the
// app's own page in Settings. The button only renders under isTauri(),
// where openExternal takes the opener path.
const openAppSettings = () => openExternal("app-settings:");

export default function ErrorScreen({
  error,
  onRetry,
  onCancel,
}: {
  error: BlockingError;
  onRetry?: () => void;
  onCancel?: () => void;
}) {
  const content = CONTENT[error.code];
  const settings = content.settings && isTauri();
  const body = (!isTauri() && WEB_BODY[error.code]) || content.body;
  // Native never shows Try Again: the app polls the real authorization
  // API and proceeds by itself the moment the pilot flips the switch.
  // The web has no such API, so the button is the recovery path there.
  const retry = onRetry && !isTauri() ? onRetry : undefined;
  // A retry that lands straight back here re-renders an identical
  // screen — without transient feedback the button reads as dead.
  const [checking, setChecking] = useState(false);
  const retryWithFeedback =
    retry &&
    (() => {
      setChecking(true);
      window.setTimeout(() => setChecking(false), 1500);
      retry();
    });
  // Location-class errors mean the pilot is about to pocket a phone
  // that cannot record: full alarm red, unmissable at arm's length.
  // busy stays calm; it is a coordination note, not a preflight abort.
  const urgent = error.code !== "busy";
  return (
    <div
      className={cx(styles.screen, urgent && styles.urgent)}
      data-testid="gps-error"
    >
      <h2>{content.title}</h2>
      <p>{body}</p>
      {settings && (
        <button className={styles.action} onClick={openAppSettings}>
          Open Settings
        </button>
      )}
      {retryWithFeedback && (
        <button className={styles.action} onClick={retryWithFeedback}>
          {checking ? "Checking…" : "Try Again"}
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
