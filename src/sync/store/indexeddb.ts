import {
  deleteLocalJson,
  getLocalJson,
  setLocalJson,
} from "../../storage/local";
import type { Credentials, CredentialStore } from "../types";

const KEY = "sync:credentials";

/**
 * The web/PWA credential store, and the desktop-Tauri one.
 *
 * Honestly the weaker half of the split: IndexedDB rides along in device
 * backups and has no hardware protection, where the Keychain has both. There
 * is nothing better in a browser — which is part of why the server grew a
 * per-user `credentialVersion`, so a leak from here is revocable for one pilot
 * instead of being permanent.
 */
export const indexedDbStore: CredentialStore = {
  load: () => getLocalJson<Credentials>(KEY),
  save: (credentials) => setLocalJson(KEY, credentials),
  clear: () => deleteLocalJson(KEY),
};
