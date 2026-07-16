import { engine } from "../engine/index";
import { isTauri } from "../engine/platform";
import {
  getBooleanSetting,
  purgeSyncedSettings,
  setBooleanSetting,
} from "../storage/local";
import {
  appleIdentityToken,
  appleProvider,
  probeEntitlementJWS,
  purchaseJWS,
  siwaProvider,
  SUBSCRIPTION_PRODUCT_ID,
} from "./providers/apple";
import * as replicate from "./replicate";
import { credentialStore } from "./store";
import type { CredentialProvider, Credentials, SyncStatus } from "./types";

/**
 * The entitlement service. It hands out CouchDB credentials and then leaves the
 * data path entirely — see types.ts. Self-hosters never touch it.
 */
const API_URL = "https://api.wingover.app";

export type { Credentials, SyncAccount, SyncStatus } from "./types";
export type { StoreProduct } from "./providers/apple";
export {
  appleProvider,
  appleSubscriptionState,
  manageSubscriptions,
  probeEntitlementJWS,
  purchaseJWS,
  siwaProvider,
  subscriptionProduct,
} from "./providers/apple";
export { fakeProvider } from "./providers/fake";
export { manualProvider } from "./providers/manual";
export const subscribe = replicate.subscribe;
export const status = replicate.syncStatus;
export const currentAccount = replicate.currentAccount;

/**
 * Recording outranks sync, wired here rather than in a component.
 *
 * Anything that must happen regardless of which page is mounted belongs
 * engine-side (STEERING) — a pilot who backgrounds the app mid-flight, or never
 * opens the Fly tab, must still get the same behavior. `idle` is the only
 * status with no session in play: `ended` still holds a flight that hasn't been
 * persisted and discarded yet, so sync stays out of the way until the engine
 * settles back to idle and the finished flight is safely in PouchDB.
 */
function watchEngine() {
  const apply = () =>
    replicate.setPaused(engine.snapshotSync().status !== "idle");
  apply();
  engine.subscribe(apply);
}

let watching = false;

/**
 * How a stored credential is refreshed at launch, chosen by who minted it.
 *
 * Dispatching on `kind` rather than refreshing everything the same way is the
 * whole reason `kind` is persisted: a self-hoster has no StoreKit and must
 * never be made to wait on it, and a subscriber's `entitled` is a server fact
 * that cannot be read off disk.
 */
function refresherFor(stored: Credentials): CredentialProvider | null {
  switch (stored.kind) {
    case "apple":
      // StoreKit is the refresher where it exists — a lapse or a renewal shows
      // up in the transaction. A browser has no StoreKit and no way to silently
      // re-prove identity at launch (identity tokens live minutes), so there
      // the stored copy is the truth until the pilot signs in again.
      return isTauri() ? appleProvider(API_URL) : null;
    case "manual":
    case "fake":
      // Nothing to re-derive: the pilot typed these, or the dev ring minted
      // them. The stored copy IS the truth.
      return null;
  }
}

/**
 * Resume sync at launch. Safe to call always: if the pilot never set sync up,
 * it does nothing.
 *
 * Without this, sync works exactly once per install: `enable()` replicates for
 * the session, and the next launch reads `off` while the credential sits unread
 * in the Keychain — the pilot's backups stop and the screen says "Flights stay
 * on this device." The store's `load()` has no other caller; this is the reason
 * it exists.
 *
 * A refresh re-derives the credential rather than replaying the stored one:
 * `entitled` goes stale the moment a subscription lapses or renews, and a
 * server-side `credentialVersion` bump changes the password — a cached copy
 * would 401 every launch with no way back. Refresh failure is not fatal: the
 * stored credential is used instead, because a pilot offline in a field must
 * still sync when they land.
 */
/**
 * "Turn off sync" must survive relaunches, or the standing opt-in below would
 * quietly re-enable what the pilot explicitly ended. Device-local, never
 * synced. Cleared by any successful enable().
 */
const SYNC_DISABLED_KEY = "syncDisabled";

export async function resume(override?: CredentialProvider): Promise<void> {
  const store = await credentialStore();
  const stored = await store.load();
  if (!stored) {
    // The subscription is a STANDING opt-in (SYNC-UX.md): the transaction is
    // the login, so a device that holds one syncs — fresh install, reinstall,
    // or a purchase whose connect call failed halfway. Only an explicit
    // "Turn off sync" keeps this quiet. A lapsed transaction connects too:
    // read-only is how a new phone pulls the logbook down.
    if (await getBooleanSetting(SYNC_DISABLED_KEY, false)) return;
    const jws = await probeEntitlementJWS();
    if (!jws) return;
    try {
      await enable(appleProvider(API_URL, jws));
    } catch {
      // Offline, or the service is down. The next launch tries again.
    }
    return;
  }

  let credentials = stored;
  const provider = override ?? refresherFor(stored);
  if (provider) {
    try {
      credentials = await provider.obtain();
      await store.save(credentials);
    } catch {
      // Offline, or the service is down. Neither is a reason to stop syncing.
    }
  }

  begin(credentials);
}

/**
 * The Subscribe button. Apple's sheet does the selling; the signed transaction
 * it hands back is traded to the server for CouchDB credentials, and from there
 * this is the same enable() as self-host. A pilot who is already subscribed
 * (second device, reinstall) lands here too — StoreKit tells them so instead of
 * charging twice, and still returns the transaction.
 *
 * Rejects with Apple's own "cancelled" (the pilot closed the sheet) and
 * "pending" (Ask to Buy / bank approval) — the UI treats those as non-errors.
 */
export async function purchase(): Promise<void> {
  const jws = await purchaseJWS(SUBSCRIPTION_PRODUCT_ID);
  // The supporter guard (SYNC-UX.md, junction 2): a pilot already synced to
  // their own server bought support, not a migration — their login is theirs.
  if (replicate.currentAccount()?.kind === "manual") return;
  await enable(appleProvider(API_URL, jws));
}

/**
 * Connect this device with the Apple subscription it already has — the Log In
 * page's "Use my subscription" door, and Restore Purchases (SYNC-UX.md).
 * Pass the JWS when a probe already fetched it; omitted, the provider asks
 * StoreKit itself.
 */
export async function connectWithSubscription(jws?: string): Promise<void> {
  await enable(appleProvider(API_URL, jws));
}

/**
 * The Sign in with Apple door: one identity token, traded for credentials.
 *
 * The transaction outranks the sign-in (SYNC-UX.md junction 4): a device
 * whose StoreKit holds a subscription belongs on the account that
 * subscription feeds — landing there and linking as we go heals a skipped
 * link step. Without one (every browser; an unsubscribed iPhone), the
 * sign-in itself is the account: the server minds an existing one or mints
 * the sign-in-born placeholder, and "Not subscribed" is a legitimate place
 * to land.
 */
export async function signIn(): Promise<void> {
  const jws = await probeEntitlementJWS();
  const token = await appleIdentityToken();
  if (jws) {
    await connectWithSubscription(jws);
    await linkAppleAccount(token);
    return;
  }
  await enable(siwaProvider(API_URL, token));
}

/** Basic auth for our API, from the pilot's own CouchDB credential — the
 * server verifies it against CouchDB itself; there is no second token type. */
function basicAuth(credentials: Credentials): string {
  return `Basic ${btoa(`${credentials.username}:${credentials.password}`)}`;
}

/**
 * Attach this Apple ID to the connected account (the post-purchase "use
 * Wingover on your computer?" step, and its catch-up on the Log In page).
 * Pass a token when the caller already holds a fresh one.
 */
export async function linkAppleAccount(token?: string): Promise<void> {
  const identityToken = token ?? (await appleIdentityToken());
  const store = await credentialStore();
  const stored = await store.load();
  if (!stored) throw new Error("Turn on sync first.");
  const response = await fetch(`${API_URL}/v1/link`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: basicAuth(stored),
    },
    body: JSON.stringify({ identityToken }),
  });
  if (response.status === 409) {
    throw new Error("This Apple ID is already linked to a different account.");
  }
  if (!response.ok) {
    throw new Error(`link failed: ${response.status} ${await response.text()}`);
  }
}

/**
 * Guideline 5.1.1(v), and basic decency: the hosted database and account,
 * actually gone. Local flights stay; the subscription is Apple's to cancel.
 * Distinct from disable(), which forgets only this device's connection.
 */
export async function deleteAccount(): Promise<void> {
  const store = await credentialStore();
  const stored = await store.load();
  if (!stored) return;
  const response = await fetch(`${API_URL}/v1/account`, {
    method: "DELETE",
    headers: { authorization: basicAuth(stored) },
  });
  if (!response.ok) {
    throw new Error(`delete failed: ${response.status}`);
  }
  await disable();
}

/** Turn sync on: obtain credentials, persist them, replicate. */
export async function enable(provider: CredentialProvider): Promise<void> {
  const credentials = await provider.obtain();
  const store = await credentialStore();
  await store.save(credentials);
  // Any successful connect is consent again: the standing opt-in resumes.
  await setBooleanSetting(SYNC_DISABLED_KEY, false);

  // Settings used to live in the synced database. Clear any that a previous
  // build left there BEFORE the first replication, or they travel to the server
  // and out to every other device — which is the whole thing the split exists
  // to prevent. Idempotent, and the only moment it can matter.
  await purgeSyncedSettings();

  begin(credentials);
}

function begin(credentials: Credentials) {
  if (!watching) {
    watching = true;
    watchEngine();
    // Replication discovers a lapse before we do — it is the thing being told
    // "no". When it downgrades itself to read-only, that verdict has to reach
    // disk, or the next launch starts pushing into the wall all over again.
    replicate.setCredentialSink((next) => {
      void credentialStore().then((store) => store.save(next));
    });
  }
  replicate.start(credentials);
}

/**
 * Turn sync off on this device. Forgets the credential; touches nothing on the
 * server and nothing in the local database — the pilot keeps every flight.
 */
export async function disable(): Promise<void> {
  replicate.stop();
  const store = await credentialStore();
  await store.clear();
  // Persisted, or the next launch's standing opt-in (resume) would undo this.
  await setBooleanSetting(SYNC_DISABLED_KEY, true);
}

export function currentStatus(): SyncStatus {
  return replicate.syncStatus();
}
