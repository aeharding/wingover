import type * as sync from "../../sync";
import { describe, type SyncTone } from "./describe";

/**
 * Everything the sheet's Connected view renders, resolved from the source of
 * truth in ONE pure place. The sheet is then a dumb presenter: every action is
 * a field here, so no screen can contradict the account/status. That is the
 * whole point — the bug class this replaced was a component caching its own
 * copy of a fact the store owns (a local `linked` flag, a stale `appleSub`)
 * and drifting from it.
 *
 * Pure and total, so the entire state matrix is unit-tested (resolveSyncView.
 * test.ts) instead of discovered on a phone.
 */
export interface SyncView {
  // The status block.
  statusLabel: string;
  statusDetail: string;
  statusTone: SyncTone;
  // Notes and actions — the sheet renders each iff its flag is true.
  supporterNote: boolean;
  showTurnOn: boolean; // "Turn on sync" (subscribed here, not connected)
  showResubscribe: boolean;
  showDormantSubscribe: boolean;
  showSignIn: boolean; // off + no live sub: Sign in with Apple
  showTurnOff: boolean;
  turnOffLabel: string;
  showManage: boolean;
  showUseOnComputer: boolean; // the link-your-Apple-account door
  showLinkedNote: boolean;
  showDelete: boolean;
  showSelfHost: boolean;
  showTurnOffNote: boolean;
}

export function resolveSyncView(
  status: sync.SyncStatus,
  account: sync.SyncAccount | null,
  appleSub: "active" | "expired" | null,
  native: boolean,
): SyncView {
  const base = describe(status);
  const off = status.state === "off";
  const dormant = status.state === "unsubscribed";
  const hosted = account?.kind === "apple";
  const supporter = account?.kind === "manual" && appleSub !== null;
  const linked = account?.login === "apple";
  const syncingLive = status.state === "syncing" && !status.readOnly;
  // A lapse: pull-only on the server (read-only) for a non-self-hoster, or a
  // turned-off device whose StoreKit sub has expired.
  const lapsed =
    (status.state === "syncing" &&
      status.readOnly &&
      account?.kind !== "manual") ||
    (off && appleSub === "expired");

  // The status block. The off branch names the subscription fact (Expired vs
  // just Off); a supporter always reads "On" regardless of the raw label.
  let statusLabel: string;
  let statusTone: SyncTone;
  let statusDetail: string;
  if (off) {
    const expired = appleSub === "expired";
    statusLabel = expired ? "Expired" : "Off";
    statusTone = expired ? "warn" : "off";
    statusDetail = "Flights are not being backed up.";
  } else if (supporter && syncingLive) {
    statusLabel = "On";
    statusTone = "on";
    statusDetail = base.detail;
  } else {
    statusLabel = base.label;
    statusTone = base.tone;
    statusDetail = base.detail;
  }

  return {
    statusLabel,
    statusDetail,
    statusTone,
    supporterNote: supporter,
    showTurnOn: off && appleSub === "active" && native,
    showResubscribe: lapsed,
    showDormantSubscribe: dormant,
    showSignIn: off && appleSub !== "active",
    showTurnOff: !off,
    turnOffLabel: !native ? "Log out" : dormant ? "Sign out" : "Turn off sync",
    showManage: !dormant && (hosted || supporter || appleSub !== null),
    showUseOnComputer: hosted && native && !dormant && !linked,
    showLinkedNote: hosted && native && !dormant && linked,
    showDelete: hosted && !dormant,
    showSelfHost: off,
    showTurnOffNote: !off && !dormant,
  };
}
