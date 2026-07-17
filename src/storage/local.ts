import PouchDB from "pouchdb-browser";

import { db } from "./db";

/**
 * Device-local storage. Never replicates.
 *
 * `db` (storage/db.ts) is the synced store — flights and pins, the things a
 * pilot owns and expects on every device. Settings are the opposite:
 * maptilerKey, mapView, units and autoEndFlight are preferences *of this
 * device*, and a phone strapped to a leg has no business dictating the map view
 * on a laptop. They lived in `db` only because there was nothing to sync to.
 */
const localDb = new PouchDB("wingover-local", {
  auto_compaction: true,
  revs_limit: 5,
});

interface SettingDoc {
  _id: string;
  _rev?: string;
  value: string;
}

const settingId = (key: string) => `setting:${key}`;

/**
 * Deletes settings left in the SYNCED database by builds that stored them there.
 *
 * Not a migration — the values are deliberately not rescued (see this module's
 * header; pre-release, and a preference is cheap to re-enter). This is about the
 * documents, not their contents: left in place they are inert until the first
 * replication, at which point a maptilerKey walks up to the server and back down
 * to every other device. Settings were moved out of `db` precisely so that
 * cannot happen; leaving the old rows behind would have kept the hole open.
 *
 * Called from sync enable() — the one moment it matters — so no launch and no
 * settings read pays for it. Idempotent: a device with nothing to purge does one
 * empty ranged query.
 */
export async function purgeSyncedSettings(): Promise<void> {
  const stale = await db.allDocs({
    startkey: "setting:",
    endkey: "setting:￰",
  });
  await Promise.all(
    stale.rows.map((row) => db.remove(row.id, row.value.rev).catch(() => {})),
  );
}

export async function getSetting(key: string): Promise<string | null> {
  try {
    const doc = await localDb.get<SettingDoc>(settingId(key));
    return doc.value;
  } catch {
    return null;
  }
}

export async function setSetting(key: string, value: string) {
  const _id = settingId(key);
  try {
    const existing = await localDb.get<SettingDoc>(_id);
    await localDb.put({ ...existing, value });
  } catch {
    await localDb.put({ _id, value });
  }
  settingListeners.get(key)?.forEach((listener) => listener(value));
}

/**
 * Same-session reactivity for settings, so a change applies immediately
 * instead of on relaunch (the map provider is the first customer: tab pages
 * stay mounted, so nothing else would ever tell their maps). Local-only by
 * construction — this store never replicates, so setSetting here is the
 * only writer there is.
 */
const settingListeners = new Map<string, Set<(value: string) => void>>();

export function onSettingChanged(
  key: string,
  listener: (value: string) => void,
): () => void {
  let listeners = settingListeners.get(key);
  if (!listeners) {
    listeners = new Set();
    settingListeners.set(key, listeners);
  }
  listeners.add(listener);
  const set = listeners;
  return () => {
    set.delete(listener);
  };
}

// The settings store is string-valued; booleans cross that edge HERE and
// nowhere else — callers never see (or mis-parse) "false".
export async function getBooleanSetting(
  key: string,
  fallback: boolean,
): Promise<boolean> {
  const value = await getSetting(key);
  return value === null ? fallback : value === "true";
}

export async function setBooleanSetting(key: string, value: boolean) {
  await setSetting(key, value ? "true" : "false");
}

interface JsonDoc<T> {
  _id: string;
  _rev?: string;
  value: T;
}

/**
 * Device-local structured storage, for things that aren't string settings —
 * currently the sync credential on platforms with no Keychain.
 */
export async function getLocalJson<T>(key: string): Promise<T | null> {
  try {
    return (await localDb.get<JsonDoc<T>>(key)).value;
  } catch {
    return null;
  }
}

export async function setLocalJson<T>(key: string, value: T) {
  try {
    const existing = await localDb.get<JsonDoc<T>>(key);
    await localDb.put({ ...existing, value });
  } catch {
    await localDb.put({ _id: key, value });
  }
}

export async function deleteLocalJson(key: string) {
  try {
    const existing = await localDb.get(key);
    await localDb.remove(existing);
  } catch {
    // Already gone.
  }
}
