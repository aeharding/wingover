import { useState } from "react";

import type { BlockingError, BlockingErrorCode } from "../../engine/types";
import { isTauri } from "../../platform/index";
import { cx } from "./cx";
import { openExternal } from "./externalLinks";

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
// remembered a denial will NOT re-prompt in the same page load: state
// the three conditions and reload for a fresh prompt. Deliberately no
// menu click-paths or browser sniffing — that copy goes stale the day
// a browser moves a button.
const WEB_BODY: Partial<Record<BlockingErrorCode, string>> = {
  "permission-denied":
    "Your browser cannot use your location. Make sure location is on for this device, allowed for your browser, and allowed for this site. Then reload this page to be asked again.",
  imprecise:
    "Recording needs your exact position, but fixes are kilometers coarse. Turn on precise location for your browser in your device's settings, then come back.",
};

// The capability scopes opener to this exact URL; iOS routes it to the
// app's own page in Settings. The button only renders under isTauri(),
// where openExternal takes the opener path.
const openAppSettings = () => openExternal("app-settings:");

// Boot failure: the WAL could not be read, so the engine cannot know
// whether a flight is live — no normal surface is safe to show (the idle
// screen's Start Flight clears the unread WAL). Reload is the only honest
// action, sanctioned here like the web denied screen's: pilot-initiated,
// and a working WAL rehydrates the session.
export function BootFailedScreen() {
  return (
    <div className={cx(styles.screen, styles.urgent)} data-testid="boot-failed">
      <h2>Something Went Wrong</h2>
      <p>
        Wingover could not read its saved flight data. Nothing has been erased.
        Reload to try again.
      </p>
      <button
        className={styles.action}
        onClick={() => window.location.reload()}
      >
        Reload
      </button>
    </div>
  );
}

// The last resort: React's tree is gone, so this is what the pilot sees
// instead of a black screen (#185). Deliberately says nothing about what
// broke — the pilot cannot act on a stack trace, and the reassurance that
// matters is that the flight is not lost. Recording keeps running through a
// React crash: the engine is module-scoped and the WAL is native-side.
export function CrashScreen() {
  return (
    <div className={cx(styles.screen, styles.urgent)} data-testid="app-crashed">
      <h2>App Crashed</h2>
      <p>
        Wingover hit an unexpected error. Any flight in progress is still being
        recorded and nothing has been erased. Reload to continue.
      </p>
      <button
        className={styles.action}
        onClick={() => window.location.reload()}
      >
        Reload
      </button>
    </div>
  );
}

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
