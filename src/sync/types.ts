export type CredentialKind = "apple" | "manual" | "fake";

/**
 * Everything needed to replicate, and nothing else.
 *
 * There is deliberately no token here. The server hands back a CouchDB
 * username/password and then leaves the data path entirely — after this the app
 * talks to CouchDB directly, and the entitlement service can be down for the
 * rest of the year without sync noticing.
 */
export interface Credentials {
  /**
   * Which provider minted this, so the next launch can refresh it from the
   * same place. Without it, resume() cannot tell a StoreKit credential from a
   * typed CouchDB URL, and would either skip the refresh or make every
   * self-hoster pay a failed StoreKit round-trip on every launch.
   */
  kind: CredentialKind;
  /**
   * THE login method on this hosted account (server-reported; "apple"
   * today, one per account ever). Gates the phone's "Use on your
   * computer" link step: once set, the door becomes a note.
   */
  login?: string | null;
  /** CouchDB origin, e.g. https://db.wingover.app */
  url: string;
  dbName: string;
  username: string;
  password: string;
  /**
   * Whether writes will actually be accepted. The server decides this — a
   * lapsed subscription is read-only, never locked out — and we mirror it by
   * replicating pull-only rather than pushing into a 403 and calling it an
   * error.
   */
  entitled: boolean;
}

/**
 * Where credentials rest between launches.
 *
 * Platform-split for a reason the pilot can't work around: this password is
 * derived server-side, never chosen, and grants remote read/write to the whole
 * account. On iOS that earns the Keychain; a browser has nothing better than
 * IndexedDB.
 */
export interface CredentialStore {
  load(): Promise<Credentials | null>;
  save(credentials: Credentials): Promise<void>;
  clear(): Promise<void>;
}

/**
 * Obtains credentials. The seam that lets the browser ring run the production
 * replication path with no Apple, no StoreKit and no Mac.
 *
 * Self-host and hosted converge here: one types a url/username/password, the
 * other trades a StoreKit transaction for the same triple. Below this,
 * everything is identical.
 */
export interface CredentialProvider {
  readonly kind: CredentialKind;
  obtain(): Promise<Credentials>;
}

/**
 * The slice of the held credential the UI is allowed to see — enough for the
 * Settings rows (Subscription: Active/Expired/—) and for the Log In page to
 * pick its furniture (Manage subscription vs. nothing), and never the password.
 */
export interface SyncAccount {
  kind: CredentialKind;
  entitled: boolean;
  login?: string | null;
}

export type SyncStatus =
  | { state: "off" }
  | { state: "connecting" }
  | {
      state: "syncing";
      lastSyncedAt: number | null;
      readOnly: boolean;
      /** Docs are moving right now. The UI spins instead of resting on
       *  the checkmark; `paused` (idle) drops it back. */
      active: boolean;
    }
  /** A flight is in progress. Recording outranks sync, always. */
  | { state: "paused" }
  /**
   * Signed in to an account that has never been entitled — the server
   * provisions storage at first subscription (SYNC-UX.md), so there is
   * nothing to replicate yet. A legitimate resting state, not an error.
   */
  | { state: "unsubscribed" }
  | { state: "error"; message: string };
