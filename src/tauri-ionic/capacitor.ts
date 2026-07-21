/**
 * A minimal window.Capacitor facade so Ionic's native hooks light up on
 * Tauri.
 *
 * Ionic's haptics are hard-wired: ion-toggle, the pickers, ion-refresher and
 * ion-reorder-group call HapticEngine, which resolves
 * `window.Capacitor.isPluginAvailable('Haptics')` →
 * `window.Capacitor.Plugins.Haptics` — no config hook, no event, silent no-op
 * when absent (@ionic/core utils/native/haptic.js). So we present exactly the
 * surface Ionic calls and forward it to the official tauri-plugin-haptics
 * (UIFeedbackGenerator / Android vibrator under the hood).
 *
 * The facade answers `isPluginAvailable` honestly — true ONLY for what we
 * actually back — which is indistinguishable from a real Capacitor app that
 * hasn't installed the other plugins. Ionic's remaining sniffers stay on
 * their no-Capacitor paths, verified: Keyboard (getResizeMode → undefined →
 * the resize-wait short-circuit our keyboard events rely on) and StatusBar
 * (ion-modal style sync → no-op).
 *
 * CAVEAT: the consumed contract is Ionic-internal (utils/native/), not public
 * API — re-verify the call shape on @ionic/core major bumps.
 *
 * The facade is necessary but not sufficient: Ionic gates its haptic call
 * sites (toggle, pickers) on isPlatform('ios'), which is UA-based — the
 * webview must present a real iPhone user agent (tauri.conf.json appends the
 * app token to a standard iPhone UA instead of replacing it; a bare custom
 * UA silently reads as desktop and no haptic call ever happens).
 */

import {
  impactFeedback,
  notificationFeedback,
  selectionFeedback,
  vibrate,
} from "@tauri-apps/plugin-haptics";

import { isTauri } from "../engine/platform";

// Capacitor's enum values, as Ionic sends them.
type CapacitorImpactStyle = "HEAVY" | "LIGHT" | "MEDIUM";
type CapacitorNotificationType = "ERROR" | "SUCCESS" | "WARNING";

const IMPACT_STYLES = {
  HEAVY: "heavy",
  LIGHT: "light",
  MEDIUM: "medium",
} as const;

const NOTIFICATION_TYPES = {
  ERROR: "error",
  SUCCESS: "success",
  WARNING: "warning",
} as const;

const Haptics = {
  impact(options?: { style?: CapacitorImpactStyle }) {
    // Capacitor defaults omitted style to HEAVY.
    void impactFeedback(IMPACT_STYLES[options?.style ?? "HEAVY"]);
  },
  notification(options?: { type?: CapacitorNotificationType }) {
    void notificationFeedback(NOTIFICATION_TYPES[options?.type ?? "SUCCESS"]);
  },
  vibrate(options?: { duration?: number }) {
    void vibrate(options?.duration ?? 300);
  },
  // Capacitor's selectionStart merely prepares the generator; the tick is
  // selectionChanged. tauri-plugin-haptics has no prepare step.
  selectionStart() {},
  selectionChanged() {
    void selectionFeedback();
  },
  selectionEnd() {},
};

export function installCapacitorShim() {
  // Mobile native only: in the browser/PWA Ionic correctly sees no native
  // layer (and the Tauri invoke wouldn't exist), and on DESKTOP Tauri the
  // haptics plugin isn't registered — a shim there would report ios/Haptics
  // and every ion-toggle drag would fire rejected invokes (Ionic's drag
  // haptic path is not platform-gated, unlike its tap path). The iOS build
  // guarantees an iPhone UA (tauri.ios.conf.json). Never fight a real
  // Capacitor.
  if (!isTauri() || "Capacitor" in window) return;
  if (!/iPhone|iPad/.test(navigator.userAgent)) return;

  const shim = {
    getPlatform: () => "ios",
    isPluginAvailable: (name: string) => Object.hasOwn(shim.Plugins, name),
    Plugins: { Haptics },
  };
  (window as { Capacitor?: unknown }).Capacitor = shim;
}
