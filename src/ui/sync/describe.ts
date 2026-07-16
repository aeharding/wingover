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
      return { label: "Off", detail: "Flights stay on this device.", tone: "" };
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
            label: "Read-only",
            detail: "Your flights are still here, and still yours.",
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
