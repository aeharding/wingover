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
 *   storekit_current_entitlement -> string | null   // signed transaction JWS
 *   storekit_purchase { productId } -> string       // signed transaction JWS
 * Both return `transaction.jwsRepresentation` verbatim — raw, unparsed. The
 * signature is the whole point; anything that re-encodes it destroys it.
 */

export async function currentEntitlementJWS(): Promise<string | null> {
  return invoke<string | null>("plugin:wingover|storekit_current_entitlement");
}

export async function purchaseJWS(productId: string): Promise<string> {
  return invoke<string>("plugin:wingover|storekit_purchase", { productId });
}

async function session(apiUrl: string, transactionJWS: string) {
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
  return (await response.json()) as Credentials;
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
      if (!jws) throw new Error("no active subscription on this Apple Account");
      return session(apiUrl, jws);
    },
  };
}
