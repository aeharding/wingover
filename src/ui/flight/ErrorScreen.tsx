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
// remembered a denial will NOT re-prompt in the same page load: the
// copy must point at where the unblock actually lives, per browser, and
// the way to a fresh prompt is a reload.
function isIos(): boolean {
  // iPadOS masquerades as macOS; multitouch gives it away.
  return (
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  );
}

function deniedWebBody(): string {
  const ua = navigator.userAgent;
  const site = /CriOS|FxiOS|EdgiOS/.test(ua)
    ? "your browser's site settings allow this site to use location"
    : isIos()
      ? "this site is allowed to ask (Safari's address bar menu, Website Settings)"
      : /Firefox/.test(ua)
        ? "the permissions icon by the address bar is not blocking location"
        : /Edg|Chrome|Chromium/.test(ua)
          ? "the icon next to the address opens Site settings with Location allowed"
          : "your browser's site settings allow location for this site";
  const system = isIos()
    ? "Location Services is on and your browser can use it (iOS Settings, Privacy and Security, Location Services)"
    : "your system's location service is on and your browser may use it";
  return `Your browser is not allowed to use your location here. Check that ${system}, and that ${site}. Then reload this page to be asked again.`;
}

function impreciseWebBody(): string {
  return isIos()
    ? "Fixes are kilometers coarse; recording needs your exact position. In iOS Settings: Privacy and Security, Location Services, Safari Websites; turn on Precise Location, then come back."
    : "Your device is reporting only a rough position, kilometers coarse. Recording needs GPS-grade fixes; check your system location settings or use a device with GPS.";
}

function webBody(code: BlockingErrorCode): string | undefined {
  if (code === "permission-denied") return deniedWebBody();
  if (code === "imprecise") return impreciseWebBody();
  return undefined;
}

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
  const body = (!isTauri() && webBody(error.code)) || content.body;
  // Web denied is a dead end for in-page retries — the browser will not
  // re-prompt until a fresh page load after the settings are fixed — so
  // it gets Reload, not a Try Again that reads as broken. Pilot-
  // initiated, pre-flight only, and the WAL rehydrates the session, so
  // the no-reload rule for data-layer swaps does not apply here.
  const reload = !isTauri() && error.code === "permission-denied";
  // Native never shows Try Again: the app polls the real authorization
  // API and proceeds by itself the moment the pilot flips the switch.
  // The web keeps it for imprecise, where a new watch CAN succeed.
  const retry = onRetry && !isTauri() && !reload ? onRetry : undefined;
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
      {reload && (
        <button
          className={styles.action}
          onClick={() => window.location.reload()}
        >
          Reload
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
