import { isTauri } from "../../engine/platform";
import type { CredentialStore } from "../types";
import { indexedDbStore } from "./indexeddb";
import { keychainAvailable, keychainStore } from "./keychain";

let chosen: Promise<CredentialStore> | null = null;

/**
 * Keychain where it exists, IndexedDB everywhere else.
 *
 * Probed rather than assumed: `isTauri()` is true on the Linux desktop dev ring
 * too, where there is no Keychain, so the plugin answers for itself. Resolved
 * once and cached — the answer cannot change within a process.
 *
 * The fallback is deliberately loud. Silently downgrading where the Keychain
 * *should* exist would move a permanent, un-resettable credential into device
 * backups without anyone noticing, which is precisely the failure this split
 * exists to prevent.
 */
export function credentialStore(): Promise<CredentialStore> {
  chosen ??= (async () => {
    if (!isTauri()) return indexedDbStore;
    if (await keychainAvailable()) return keychainStore;
    console.warn(
      "sync: native Keychain unavailable under Tauri — falling back to " +
        "IndexedDB. Expected on the desktop dev ring; on iOS it means the " +
        "credential is being stored somewhere it will reach backups.",
    );
    return indexedDbStore;
  })();
  return chosen;
}
