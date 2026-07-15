import type { CredentialProvider, Credentials } from "../types";

/**
 * Self-host: the pilot types a CouchDB URL and credentials.
 *
 * This is the whole self-host story, and it is deliberately the *same* shape
 * the hosted path produces. If this ever stops working, "run your own CouchDB
 * for free" has become theatre — so it is a real provider, not a fallback.
 *
 * `entitled: true` because there is no paywall on a database the pilot owns.
 * Their CouchDB will answer for itself if the credentials are wrong.
 */
export function manualProvider(input: {
  url: string;
  dbName: string;
  username: string;
  password: string;
}): CredentialProvider {
  return {
    kind: "manual",
    async obtain(): Promise<Credentials> {
      return {
        url: input.url.replace(/\/+$/, ""),
        dbName: input.dbName,
        username: input.username,
        password: input.password,
        entitled: true,
      };
    },
  };
}
