import type * as sync from "../../sync";

/**
 * The one place a sync state becomes words. Shared by the Settings row and the
 * Log In page — the version that fell back to `status.state` put "paused", an
 * internal identifier, in the row for the length of every flight.
 */
export function describe(status: sync.SyncStatus): {
  label: string;
  detail: string;
  tone: string;
} {
  switch (status.state) {
    case "off":
      return {
        label: "Off",
        detail: "Flights are not being backed up.",
        tone: "",
      };
    case "connecting":
      return { label: "Connecting", detail: "", tone: "" };
    case "paused":
      // Recording outranks sync, always — and saying so is better than looking
      // broken mid-flight.
      return {
        label: "Paused",
        detail: "Syncs when the flight ends.",
        tone: "",
      };
    case "unsubscribed":
      // Signed in, never subscribed — the account is a name awaiting its
      // first entitlement. Neutral, not amber: nothing is degraded.
      return {
        label: "Not subscribed",
        detail: "Flights stay on this device until you subscribe.",
        tone: "",
      };
    case "syncing":
      return status.readOnly
        ? {
            // "Read-only" was database vocabulary; the pilot's reality is
            // simply "not subscribed": new flights stay on the phone, and
            // everything already synced stays safe on the server — that
            // courtesy is the point, not a mode to learn. (Under the hood it
            // is still pull-only, so a new phone can fetch the logbook.)
            label: "Not subscribed",
            detail:
              "New flights stay on this device. Everything synced is safe.",
            tone: "sync-state-readonly",
          }
        : {
            label: "On",
            detail: status.lastSyncedAt
              ? `Last synced ${new Date(status.lastSyncedAt).toLocaleTimeString()}`
              : "Waiting for changes",
            tone: "",
          };
    case "error":
      return { label: "Problem", detail: "", tone: "sync-state-error" };
  }
}
