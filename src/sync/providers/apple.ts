import { invoke } from "@tauri-apps/api/core";

import type { CredentialProvider, Credentials } from "../types";

/**
 * Subscribe-first: the StoreKit transaction both authenticates and entitles, so
 * there is no login in the common path. A pilot subscribes and is synced.
 *
 * The transaction is Apple-signed and the server verifies it against Apple's
 * root CAs; we are only the courier. `currentEntitlements` is also how a second
 * iPhone joins and how a reinstall recovers — same Apple Account, same
 * transaction, same account, no "restore" button.
 *
 * CONTRACT for the Swift side (src-tauri/plugins/wingover):
 *   storekit_current_entitlement { productIds } -> string | null  // signed JWS
 *   storekit_purchase { productId } -> string                     // signed JWS
 * Both return `transaction.jwsRepresentation` verbatim — raw, unparsed. The
 * signature is the whole point; anything that re-encodes it destroys it.
 */

/** The auto-renewable subscription, as configured in App Store Connect. */
export const SUBSCRIPTION_PRODUCT_ID = "app.wingover.sync.monthly";

/**
 * The newest transaction for our subscription, active OR expired.
 *
 * Expired counts: a lapsed pilot is read-only, never locked out, and this is
 * the only way they get their logbook onto a new phone. The server decides what
 * it's worth — see the fallback in WingoverPlugin.swift.
 */
export async function currentEntitlementJWS(): Promise<string | null> {
  return invoke<string | null>("plugin:wingover|storekit_current_entitlement", {
    productIds: [SUBSCRIPTION_PRODUCT_ID],
  });
}

export async function purchaseJWS(productId: string): Promise<string> {
  return invoke<string>("plugin:wingover|storekit_purchase", { productId });
}

async function session(
  apiUrl: string,
  transactionJWS: string,
): Promise<Credentials> {
  const response = await fetch(`${apiUrl}/v1/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transactionJWS }),
  });
  if (!response.ok) {
    throw new Error(
      `session failed: ${response.status} ${await response.text()}`,
    );
  }
  // The server sends the CouchDB triple and its entitlement verdict; the
  // provenance is ours to stamp, because only this side knows who asked.
  return { ...((await response.json()) as Credentials), kind: "apple" };
}

/**
 * @param transactionJWS a freshly-purchased transaction, or omit to use the
 * current entitlement (reinstall, second device, app relaunch).
 */
export function appleProvider(
  apiUrl: string,
  transactionJWS?: string,
): CredentialProvider {
  return {
    kind: "apple",
    async obtain(): Promise<Credentials> {
      const jws = transactionJWS ?? (await currentEntitlementJWS());
      // Genuinely nothing: this Apple Account has never subscribed. A LAPSED
      // one still returns a transaction — that's the point — and the server
      // answers it with read-only credentials rather than a locked door.
      if (!jws) {
        throw new Error("This Apple Account has never subscribed to Wingover.");
      }
      return session(apiUrl, jws);
    },
  };
}
