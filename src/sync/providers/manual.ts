import type { CredentialProvider, Credentials } from "../types";

/**
 * Self-host: the pilot types a CouchDB URL and credentials.
 *
 * This is the whole self-host story, and it is deliberately the *same* shape
 * the hosted path produces. If this ever stops working, "run your own CouchDB
 * for free" has become theatre — so it is a real provider, not a fallback.
 *
 * `entitled: true` because there is no paywall on a database the pilot owns.
 */

/**
 * A scheme is not pedantry, it is the difference between syncing and not.
 *
 * PouchDB given a schemeless string — `couch.example.com`, the natural thing to
 * type in a field labelled "Server" — does not fail. It picks the idb adapter
 * and creates a LOCAL database of that name, and db.sync() then happily
 * replicates the device to itself and reports a healthy "On" forever, while the
 * pilot reads "Backed up off your phone" and nothing has ever left the phone.
 */
function normalizeUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error("Server must start with https:// or http://");
  }
  try {
    new URL(trimmed);
  } catch {
    throw new Error(`Not a valid address: ${trimmed}`);
  }
  return trimmed;
}

/**
 * Turn a preflight response into something a pilot can act on.
 *
 * The 403 case is not hypothetical: CouchDB 3.5 ships `chttpd_auth_lockout`
 * with `mode = enforce`, and five wrong passwords from one IP lock the account
 * for five minutes — during which the CORRECT password is refused too
 * (verified against 3.5.2). Saying "wrong password" there would send the pilot
 * to retype a password that was already right.
 */
async function explain(response: Response, url: string, dbName: string) {
  if (response.status === 401) {
    throw new Error("Wrong username or password.");
  }
  if (response.status === 403) {
    const reason = await response
      .json()
      .then((body: { reason?: string }) => body.reason ?? "")
      .catch(() => "");
    if (/locked/i.test(reason)) {
      throw new Error(
        "Too many failed attempts. CouchDB locked this account; wait five minutes, then try again.",
      );
    }
    throw new Error(`This user can't access ${dbName}.`);
  }
  if (response.status === 404) {
    throw new Error(`No database named "${dbName}" on ${url}.`);
  }
  throw new Error(`${url} answered ${response.status}.`);
}

export function manualProvider(input: {
  url: string;
  dbName: string;
  username: string;
  password: string;
}): CredentialProvider {
  return {
    kind: "manual",
    /**
     * Prove the connection before it is saved.
     *
     * Without this the pilot gets "Connected" for a typo — replication is
     * fire-and-forget, so nothing here ever learns it failed. Worse than the
     * lie: db.sync() opens its handshake in parallel, ~7 authenticated requests
     * inside 700ms (measured), and CouchDB 3.5's chttpd_auth_lockout locks the
     * account at 5 failures — then refuses the CORRECT password for the next
     * five minutes. One typo, one attempt, and fixing the typo doesn't help.
     *
     * One request cannot trip a threshold of five, and it turns the whole thing
     * into one sentence at the moment the pilot is still looking at the field.
     */
    async obtain(): Promise<Credentials> {
      const url = normalizeUrl(input.url);
      const dbName = input.dbName.trim();
      const auth = btoa(`${input.username}:${input.password}`);

      let response: Response;
      try {
        response = await fetch(`${url}/${encodeURIComponent(dbName)}`, {
          headers: { Authorization: `Basic ${auth}` },
        });
      } catch {
        // fetch rejects identically for "host is wrong" and "host is fine but
        // refused the origin", and the browser only ever tells the console
        // which. CORS is the overwhelmingly likelier of the two for someone who
        // just stood up their own CouchDB, so it gets named.
        throw new Error(
          `Couldn't reach ${url}. Check the address, and that CouchDB allows this origin (see the CORS setup in the README).`,
        );
      }

      if (!response.ok) await explain(response, url, dbName);

      return {
        kind: "manual",
        url,
        dbName,
        username: input.username,
        password: input.password,
        entitled: true,
      };
    },
  };
}
