import { engine } from "../engine/index";
import { purgeSyncedSettings } from "../storage/local";
import { appleProvider } from "./providers/apple";
import * as replicate from "./replicate";
import { credentialStore } from "./store";
import type { CredentialProvider, Credentials, SyncStatus } from "./types";

/**
 * The entitlement service. It hands out CouchDB credentials and then leaves the
 * data path entirely — see types.ts. Self-hosters never touch it.
 */
const API_URL = "https://api.wingover.app";

export type { Credentials, SyncStatus } from "./types";
export { appleProvider, purchaseJWS } from "./providers/apple";
export { fakeProvider } from "./providers/fake";
export { manualProvider } from "./providers/manual";
export const subscribe = replicate.subscribe;
export const status = replicate.syncStatus;

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
      return appleProvider(API_URL);
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
export async function resume(override?: CredentialProvider): Promise<void> {
  const store = await credentialStore();
  const stored = await store.load();
  if (!stored) return;

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

/** Turn sync on: obtain credentials, persist them, replicate. */
export async function enable(provider: CredentialProvider): Promise<void> {
  const credentials = await provider.obtain();
  const store = await credentialStore();
  await store.save(credentials);

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
}

export function currentStatus(): SyncStatus {
  return replicate.syncStatus();
}
