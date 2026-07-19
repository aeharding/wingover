import { invoke } from "@tauri-apps/api/core";

import { isTauri } from "../../engine/platform";
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
 *   storekit_products { productIds } -> { products: StoreProduct[] }
 * The JWS commands return `transaction.jwsRepresentation` verbatim — raw,
 * unparsed. The signature is the whole point; anything that re-encodes it
 * destroys it.
 */

/** The auto-renewable subscription terms, as configured in App Store
 * Connect. One subscription group: buying either replaces the other, and
 * Apple prorates the switch itself. */
export const SUBSCRIPTION_PRODUCT_IDS = {
  monthly: "app.wingover.sync.monthly",
  yearly: "app.wingover.sync.yearly",
} as const;

export type SubscriptionTerm = keyof typeof SUBSCRIPTION_PRODUCT_IDS;

const ALL_PRODUCT_IDS = Object.values(SUBSCRIPTION_PRODUCT_IDS);

/**
 * The newest transaction for our subscription, active OR expired.
 *
 * Expired counts: a lapsed pilot is read-only, never locked out, and this is
 * the only way they get their logbook onto a new phone. The server decides what
 * it's worth — see the fallback in WingoverPlugin.swift.
 */
export async function currentEntitlementJWS(): Promise<string | null> {
  return invoke<string | null>("plugin:wingover|storekit_current_entitlement", {
    productIds: ALL_PRODUCT_IDS,
  });
}

/**
 * The StoreKit environment this build is running in — Sandbox on TestFlight,
 * Production on the App Store — from the app's AppTransaction receipt. Available
 * locally, with no subscription and offline, so a relaunch can catch a
 * cross-environment install (TestFlight over App Store, or the reverse) before
 * it replicates the wrong account's cached credentials. Native only.
 */
export async function appEnvironment(): Promise<"Sandbox" | "Production"> {
  const environment = await invoke<string>(
    "plugin:wingover|storekit_environment",
  );
  return environment === "Sandbox" ? "Sandbox" : "Production";
}

/**
 * True when a STORED credential belongs to a different StoreKit environment than
 * the one this build runs in — the case resume() must NOT replicate, because it
 * would push this build's flights into the OTHER environment's account. Only a
 * stamped apple credential can mismatch: an UNSTAMPED one (minted before the
 * server began reporting `environment`) can't be judged here and rides the next
 * online refresh to re-stamp; manual/self-host creds have no StoreKit
 * environment. A null `live` (a cold or failed AppTransaction read) means "can't
 * tell" and fails OPEN — better than stranding a legitimate offline pilot. All
 * of these misplace only the pilot's OWN data, never another user's.
 */
export function isEnvMismatch(
  stored: Credentials,
  live: "Sandbox" | "Production" | null,
): boolean {
  return (
    stored.kind === "apple" &&
    !!stored.environment &&
    !!live &&
    stored.environment !== live
  );
}

export async function purchaseJWS(productId: string): Promise<string> {
  return invoke<string>("plugin:wingover|storekit_purchase", { productId });
}

/**
 * currentEntitlementJWS as a question rather than a call: answers null wherever
 * there is no StoreKit to ask (a browser; the desktop ring's stub) instead of
 * rejecting. This is what decides whether "Use my subscription" is offered on
 * the Log In page (SYNC-UX.md) — a door that can only fail is not shown.
 */
export async function probeEntitlementJWS(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return await currentEntitlementJWS();
  } catch {
    return null;
  }
}

/**
 * What this device's Apple ID holds, decoded locally, for DISPLAY ONLY.
 *
 * The JWS payload is plain base64url JSON; reading expiresDate to pick a
 * label ("Active" vs "Expired") is not trusting it — entitlement remains the
 * server's verdict, verified against Apple's roots. This exists because the
 * Subscription rail's state must show even when the login rail doesn't carry
 * it: the supporter (paying while self-hosting) and the lapsed pilot who
 * turned sync off would otherwise read "—", indistinguishable from never
 * having subscribed.
 *
 * null = no StoreKit here (browser, desktop ring) or no transaction at all.
 */
export async function appleSubscriptionState(): Promise<
  "active" | "expired" | null
> {
  const jws = await probeEntitlementJWS();
  if (!jws) return null;
  try {
    const part = jws.split(".")[1] ?? "";
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(
      atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)),
    ) as { expiresDate?: number };
    return payload.expiresDate !== undefined &&
      payload.expiresDate > Date.now()
      ? "active"
      : "expired";
  } catch {
    return null;
  }
}

/**
 * The web Services ID, as configured in the Apple developer portal (a separate
 * identifier from the app's bundle ID — both are accepted audiences server-side,
 * see wingover.app's config.apple.clientIds).
 */
export const SIWA_WEB_CLIENT_ID = "app.wingover.signin";

/** The slice of Apple's appleid.auth.js we use. */
interface AppleIDSdk {
  auth: {
    init(config: {
      clientId: string;
      scope?: string;
      redirectURI: string;
      usePopup: boolean;
    }): void;
    signIn(): Promise<{ authorization: { id_token: string } }>;
  };
}

/**
 * One Face ID tap or one Apple popup, one identity token (a JWT carrying the
 * stable subject; we request no scopes). Native goes through the plugin's
 * AuthenticationServices sheet; the web loads Apple's SDK on demand — it never
 * enters the bundle, and Apple requires it be served from their CDN anyway.
 *
 * Rejects with "cancelled" (both paths, normalized) when the pilot closes the
 * sheet or popup — callers treat that as a non-event.
 *
 * Web caveat: Apple refuses unregistered origins, so this only works on the
 * deployed site (the domain is registered to the Services ID), never on a dev
 * server.
 */
export async function appleIdentityToken(): Promise<string> {
  if (isTauri()) {
    return invoke<string>("plugin:wingover|sign_in_with_apple");
  }

  const w = window as unknown as { AppleID?: AppleIDSdk };
  if (!w.AppleID) {
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src =
        "https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js";
      script.onload = () => resolve();
      script.onerror = () =>
        reject(new Error("Couldn't load Apple's sign-in script."));
      document.head.append(script);
    });
  }
  const apple = w.AppleID;
  if (!apple) throw new Error("Apple's sign-in script didn't initialize.");

  apple.auth.init({
    clientId: SIWA_WEB_CLIENT_ID,
    redirectURI: `${location.origin}/`,
    usePopup: true,
  });
  try {
    const result = await apple.auth.signIn();
    return result.authorization.id_token;
  } catch (error) {
    if ((error as { error?: string } | null)?.error === "popup_closed_by_user") {
      throw new Error("cancelled", { cause: error });
    }
    throw error instanceof Error
      ? error
      : new Error(String(error), { cause: error });
  }
}

/**
 * Login by identity: trades a Sign in with Apple token for the same CouchDB
 * triple the transaction path mints. This is the PWA's whole door, and on iOS
 * it's how a web-subscribed pilot (someday) or a linked account signs in.
 *
 * Same `kind: "apple"` as the transaction path — it IS the same account; the
 * two obtainments only differ in which proof they carry. resume() refreshes
 * apple-kind credentials via StoreKit where it exists and trusts the stored
 * copy where it doesn't (identity tokens live minutes, so a browser cannot
 * silently re-prove identity at launch).
 */
export function siwaProvider(
  apiUrl: string,
  identityToken: string,
): CredentialProvider {
  return {
    kind: "apple",
    async obtain(): Promise<Credentials> {
      let response: Response;
      try {
        response = await fetch(`${apiUrl}/v1/session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ identityToken }),
        });
      } catch (error) {
        throw unreachable(error);
      }
      if (response.status === 404) {
        // The server knows this Apple ID from nowhere: no linked account.
        // Marked, because on iOS the caller can self-heal via StoreKit.
        throw Object.assign(
          new Error(
            "No account is linked to this Apple ID yet. Subscribe in the iOS app, then link it there.",
          ),
          { unlinked: true },
        );
      }
      if (!response.ok) {
        throw new Error(
          `session failed: ${response.status} ${await response.text()}`,
        );
      }
      return { ...((await response.json()) as Credentials), kind: "apple" };
    },
  };
}

/** Whether signIn's failure was "the server has no linked account" (see above). */
export function isUnlinked(error: unknown): boolean {
  return Boolean((error as { unlinked?: boolean } | null)?.unlinked);
}

export interface StoreProduct {
  id: string;
  displayName: string;
  /** Apple's own localized price string — never format prices ourselves. */
  displayPrice: string;
  description: string;
}

/**
 * The subscription as StoreKit sees it, or null when there is no StoreKit to
 * ask (a browser, the Linux desktop ring — its stub answers UnsupportedPlatform)
 * or when the App Store doesn't serve the product (not configured in App Store
 * Connect yet, or offline). Null is the UI's cue to keep Subscribe disabled:
 * a live button whose only possible outcome is "no such product" is worse than
 * an honest dead one.
 */
export async function subscriptionProducts(): Promise<StoreProduct[]> {
  if (!isTauri()) return [];
  try {
    const { products } = await invoke<{ products: StoreProduct[] }>(
      "plugin:wingover|storekit_products",
      { productIds: ALL_PRODUCT_IDS },
    );
    return products;
  } catch {
    return [];
  }
}

/**
 * Apple's subscription-management sheet, in-app. The public apps.apple.com
 * page never lists sandbox/TestFlight subscriptions; this sheet shows the
 * current storefront's, real or test. Native only.
 */
export async function manageSubscriptions(): Promise<void> {
  return invoke("plugin:wingover|storekit_manage_subscriptions");
}

/** fetch rejects with WebKit's bare "Load failed" — name the actual problem. */
function unreachable(error: unknown): Error {
  return new Error(
    "Couldn't reach wingover.app. Check your connection and try again.",
    { cause: error },
  );
}

async function session(
  apiUrl: string,
  transactionJWS: string,
): Promise<Credentials> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl}/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transactionJWS }),
    });
  } catch (error) {
    throw unreachable(error);
  }
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
