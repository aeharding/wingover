import { engine } from "../engine/index";
import { purgeSyncedSettings } from "../storage/local";
import * as replicate from "./replicate";
import { credentialStore } from "./store";
import type { CredentialProvider, Credentials, SyncStatus } from "./types";

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
  const apply = () => replicate.setPaused(engine.snapshotSync().status !== "idle");
  apply();
  engine.subscribe(apply);
}

let watching = false;

/**
 * Resume sync at launch. Safe to call always: if the pilot never set sync up,
 * it does nothing.
 *
 * `provider` re-derives the credential rather than replaying the stored one.
 * That matters twice: `entitled` is a server fact that goes stale the moment a
 * subscription lapses or renews, and a server-side `credentialVersion` bump
 * changes the password — a cached copy would 401 every launch with no way back.
 * Refresh failure is not fatal: the stored credential is used instead, because
 * a pilot offline in a field must still sync when they land.
 */
export async function resume(provider?: CredentialProvider): Promise<void> {
  const store = await credentialStore();
  const stored = await store.load();
  if (!stored) return;

  let credentials = stored;
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
