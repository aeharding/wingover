import type * as sync from "../../../sync/index";

/**
 * A sync state as a SEMANTIC tone, not a CSS class: every surface (the Settings
 * row, the desktop rail chip, the sheet) maps this one tone to its own styling,
 * so they can never disagree on WHICH state a status is. The rail used to paint
 * every non-On/Off state amber, including a normal in-flight pause; now the
 * derivation lives here once. "warn" is a lapse (amber, never red); "error" is
 * a real problem (red); "neutral" is a transient/quiet state (no alarm).
 */
export type SyncTone = "on" | "off" | "warn" | "error" | "neutral";

/**
 * The one place a sync state becomes words + a tone. Shared by every surface —
 * the version that fell back to `status.state` put "paused", an internal
 * identifier, in the row for the length of every flight.
 */
// "just now", then locale-correct minutes/hours/days. Read at render time;
// a surface that sits open shows the moment it last derived, same as the
// Settings row.
function relativeTime(then: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "just now";
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return rtf.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  return rtf.format(-Math.round(hours / 24), "day");
}

export function describe(status: sync.SyncStatus): {
  label: string;
  detail: string;
  tone: SyncTone;
} {
  switch (status.state) {
    case "off":
      return {
        label: "Off",
        detail: "Flights are not being backed up.",
        tone: "off",
      };
    case "connecting":
      return { label: "Connecting", detail: "", tone: "neutral" };
    case "offline":
      // Neutral, not a warning: nothing is broken and nothing is lost, so the
      // detail line is the whole point. Replication is still retrying, and
      // will heal on its own the moment there is signal.
      return {
        label: "Offline",
        detail: "Flights are saved here and will sync when you have signal.",
        tone: "neutral",
      };
    case "paused":
      // Recording outranks sync, always — and saying so is better than looking
      // broken mid-flight. Neutral: it is not a warning.
      return {
        label: "Paused",
        detail: "Syncs when the flight ends.",
        tone: "neutral",
      };
    case "unsubscribed":
      // Signed in, never subscribed — the account is a name awaiting its
      // first entitlement. Neutral, not amber: nothing is degraded.
      return {
        label: "Not subscribed",
        detail: "Flights stay on this device until you subscribe.",
        tone: "neutral",
      };
    case "syncing":
      return status.readOnly
        ? {
            // "Read-only" was database vocabulary; the pilot's reality is
            // simply "not subscribed": new flights stay on the phone, and
            // everything already synced stays safe on the server — that
            // courtesy is the point, not a mode to learn. (Under the hood it
            // is still pull-only, so a new phone can fetch the logbook.)
            // Amber (warn), never red — nothing is lost.
            label: "Not subscribed",
            detail:
              "New flights stay on this device. Everything synced is safe.",
            tone: "warn",
          }
        : {
            label: "On",
            detail: status.lastSyncedAt
              ? `Last synced ${relativeTime(status.lastSyncedAt)}`
              : "Waiting for changes",
            tone: "on",
          };
    case "error":
      return { label: "Problem", detail: "", tone: "error" };
  }
}
