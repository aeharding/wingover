import type { CredentialProvider, Credentials } from "../types";

/**
 * The browser-ring provider. Trades nothing for credentials against a local
 * CouchDB, via Vite middleware (see dev/fake-auth-plugin.ts).
 *
 * This is the seam that makes sync developable and e2e-testable with no Apple
 * developer account, no StoreKit, no subscription and no Mac — the same trick
 * the recording engine plays with its mocked native source. Everything below
 * this line is the production replication path; only the way credentials are
 * *obtained* is faked.
 *
 * Never shipped: chosen only when the dev endpoint answers.
 */
export function fakeProvider(
  options: { entitled?: boolean; account?: string } = {},
): CredentialProvider {
  return {
    kind: "fake",
    async obtain(): Promise<Credentials> {
      const response = await fetch("/v1/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fake: true,
          account: options.account ?? "dev",
          // Lets an e2e test drive the lapsed, read-only path — the one a
          // paying pilot must never hit, and the one nobody tests by hand.
          entitled: options.entitled ?? true,
        }),
      });
      if (!response.ok) {
        throw new Error(`fake session failed: ${response.status}`);
      }
      return { ...((await response.json()) as Credentials), kind: "fake" };
    },
  };
}
