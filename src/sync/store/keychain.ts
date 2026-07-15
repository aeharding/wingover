import { invoke } from "@tauri-apps/api/core";

import type { Credentials, CredentialStore } from "../types";

const KEY = "sync.credentials";

/**
 * The iOS credential store, backed by the Keychain via the wingover plugin.
 *
 * Why the Keychain and not IndexedDB: this password is derived server-side, the
 * pilot never chooses it and cannot reset it, and it grants remote read/write
 * to the entire account — a strictly larger blast radius than the on-device
 * flights an app-container compromise would already expose. IndexedDB also
 * rides along in iCloud and iTunes backups; a Keychain item written
 * `ThisDeviceOnly` never leaves the device at all.
 *
 * That costs nothing here, because the credential is *re-derivable*: any device
 * signed into the Apple Account can obtain it again from a StoreKit
 * transaction. It never needs to be backed up, so refusing to back it up is
 * free.
 *
 * CONTRACT for the Swift side (src-tauri/plugins/wingover):
 *   keychain_available -> boolean   // false on non-iOS, so desktop Tauri falls back
 *   keychain_get { key } -> string | null
 *   keychain_set { key, value }     // kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
 *   keychain_delete { key }
 */
export const keychainStore: CredentialStore = {
  async load() {
    const raw = await invoke<string | null>("plugin:wingover|keychain_get", {
      key: KEY,
    });
    return raw ? (JSON.parse(raw) as Credentials) : null;
  },

  async save(credentials) {
    await invoke("plugin:wingover|keychain_set", {
      key: KEY,
      value: JSON.stringify(credentials),
    });
  },

  async clear() {
    await invoke("plugin:wingover|keychain_delete", { key: KEY });
  },
};

/** Whether the native Keychain is actually available (iOS only). */
export async function keychainAvailable(): Promise<boolean> {
  try {
    return await invoke<boolean>("plugin:wingover|keychain_available");
  } catch {
    // Plugin absent or command unimplemented — e.g. desktop Tauri, or an iOS
    // build predating the keychain commands.
    return false;
  }
}
