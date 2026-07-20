import { describe, expect, test } from "vitest";

import type * as sync from "../../sync";
import { resolveSyncView } from "./resolveSyncView";

// The whole point of the resolver: the sheet's state matrix, testable as data
// instead of discovered on a phone. Before this, the sheet mixed the store with
// local shadow caches and no unit could reach it.
const syncing = (readOnly: boolean): sync.SyncStatus => ({
  state: "syncing",
  readOnly,
  lastSyncedAt: 1,
  active: false,
});
const OFF: sync.SyncStatus = { state: "off" };
const DORMANT: sync.SyncStatus = { state: "unsubscribed" };
const PAUSED: sync.SyncStatus = { state: "paused" };
const CONNECTING: sync.SyncStatus = { state: "connecting" };
const PROBLEM: sync.SyncStatus = { state: "error", message: "boom" };

const apple = (login: string | null, entitled = true): sync.SyncAccount => ({
  kind: "apple",
  entitled,
  login,
});
const manual = (): sync.SyncAccount => ({
  kind: "manual",
  entitled: true,
  login: null,
});

const NATIVE = true;
const WEB = false;

describe("resolveSyncView", () => {
  test("On, linked apple: green; Manage + Linked note + Delete; no offers", () => {
    const v = resolveSyncView(syncing(false), apple("apple"), "active", NATIVE);
    expect(v.statusLabel).toBe("On");
    expect(v.statusTone).toBe("on");
    expect(v.showManage).toBe(true);
    expect(v.showLinkedNote).toBe(true);
    expect(v.showUseOnComputer).toBe(false);
    expect(v.showDelete).toBe(true);
    expect(v.showTurnOff).toBe(true);
    expect(v.turnOffLabel).toBe("Turn off sync");
    expect(v.showResubscribe).toBe(false);
    expect(v.showDormantSubscribe).toBe(false);
    expect(v.showSignIn).toBe(false);
    expect(v.showTurnOffNote).toBe(true);
    expect(v.statusDetail).toContain("Last synced");
  });

  test("On, NOT linked: offers Use on your computer instead of the Linked note", () => {
    const v = resolveSyncView(syncing(false), apple(null), "active", NATIVE);
    expect(v.showUseOnComputer).toBe(true);
    expect(v.showLinkedNote).toBe(false);
  });

  test("Lapsed (read-only apple): amber, Resubscribe, still Manage", () => {
    const v = resolveSyncView(
      syncing(true),
      apple("apple", false),
      "expired",
      NATIVE,
    );
    expect(v.statusLabel).toBe("Not subscribed");
    expect(v.statusTone).toBe("warn");
    expect(v.showResubscribe).toBe(true);
    expect(v.showManage).toBe(true);
  });

  test("Dormant: Manage is HIDDEN (the leak fix), Sign out, Subscribe offer", () => {
    const v = resolveSyncView(DORMANT, apple("apple", false), null, NATIVE);
    expect(v.statusLabel).toBe("Not subscribed");
    expect(v.statusTone).toBe("neutral");
    expect(v.showManage).toBe(false); // never Manage for a never-subscribed account
    expect(v.showDormantSubscribe).toBe(true);
    expect(v.showLinkedNote).toBe(false);
    expect(v.showUseOnComputer).toBe(false);
    expect(v.showDelete).toBe(false);
    expect(v.turnOffLabel).toBe("Sign out");
  });

  test("Off + expired: Expired amber, Resubscribe + Sign in + self-host, no turn-off", () => {
    const v = resolveSyncView(OFF, null, "expired", NATIVE);
    expect(v.statusLabel).toBe("Expired");
    expect(v.statusTone).toBe("warn");
    expect(v.showResubscribe).toBe(true);
    expect(v.showSignIn).toBe(true);
    expect(v.showSelfHost).toBe(true);
    expect(v.showTurnOff).toBe(false);
    expect(v.showTurnOn).toBe(false);
  });

  test("Off + active sub: Turn on sync only on native", () => {
    expect(resolveSyncView(OFF, null, "active", NATIVE).showTurnOn).toBe(true);
    expect(resolveSyncView(OFF, null, "active", WEB).showTurnOn).toBe(false);
  });

  test("Off, no sub: red Off, Sign in + self-host, nothing to manage", () => {
    const v = resolveSyncView(OFF, null, null, NATIVE);
    expect(v.statusLabel).toBe("Off");
    expect(v.statusTone).toBe("off");
    expect(v.showSignIn).toBe(true);
    expect(v.showSelfHost).toBe(true);
    expect(v.showManage).toBe(false);
    expect(v.showTurnOn).toBe(false);
    expect(v.statusDetail).toBe("Flights are not being backed up.");
    expect(v.showTurnOffNote).toBe(false);
  });

  test("Supporter (self-host + a StoreKit sub): reads On, thanks note, Manage, no Delete, never lapsed", () => {
    const v = resolveSyncView(syncing(false), manual(), "active", NATIVE);
    expect(v.statusLabel).toBe("On");
    expect(v.statusTone).toBe("on");
    expect(v.supporterNote).toBe(true);
    expect(v.showManage).toBe(true);
    expect(v.showDelete).toBe(false); // not hosted
    expect(v.showResubscribe).toBe(false);
  });

  test("Error → red; Paused/Connecting → neutral (the rail's amber-everything bug)", () => {
    expect(
      resolveSyncView(PROBLEM, apple("apple"), "active", NATIVE).statusTone,
    ).toBe("error");
    expect(
      resolveSyncView(PAUSED, apple("apple"), "active", NATIVE).statusTone,
    ).toBe("neutral");
    expect(
      resolveSyncView(CONNECTING, apple("apple"), "active", NATIVE).statusTone,
    ).toBe("neutral");
  });

  test("turnOffLabel: the web is always Log out", () => {
    expect(
      resolveSyncView(syncing(false), apple("apple"), "active", WEB)
        .turnOffLabel,
    ).toBe("Log out");
  });
});
