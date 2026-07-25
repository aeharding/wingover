// Sync's half of the native wire contract, from the shared fixtures
// (src-tauri/plugins/wingover/contract-fixtures/). It lives here rather
// than beside the engine's half because a contract is tested where its
// reader can be imported: the Keychain store and the StoreKit provider are
// private to this layer.
//
// The engine's file owns the fixture schema, the Swift literal check and
// the command inventory; it lists these surfaces in CLAIMED_ELSEWHERE.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { expectJs, fixtures, jsPayload } from "../contractFixtures";
import {
  appEnvironment,
  appleIdentityToken,
  currentEntitlementJWS,
  purchaseJWS,
  subscriptionProducts,
} from "./providers/apple";
import { keychainAvailable, keychainStore } from "./store/keychain";

const core = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => core);
// StoreKit and the Keychain exist only under Tauri; the fixtures describe
// the native ring.
vi.mock("../engine/platform", () => ({ isTauri: () => true }));

const MINE = new Set([
  "keychain_available",
  "keychain_get",
  "sign_in_with_apple",
  "storekit_current_entitlement",
  "storekit_environment",
  "storekit_products",
  "storekit_purchase",
]);

function stub(command: string, response: unknown) {
  core.invoke.mockImplementation((invoked: string) =>
    Promise.resolve(invoked === command ? response : null),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sync reads every native fixture it owns through the real path", () => {
  for (const fixture of fixtures.filter((candidate) =>
    MINE.has(candidate.surface),
  )) {
    it(`${fixture.file}`, async () => {
      const payload = jsPayload(fixture);
      stub(`plugin:wingover|${fixture.surface}`, payload);
      switch (fixture.surface) {
        case "keychain_available":
          expect(await keychainAvailable()).toBe(
            expectJs(fixture, "available"),
          );
          break;
        case "keychain_get":
          expect(await keychainStore.load()).toStrictEqual(
            expectJs(fixture, "credentials"),
          );
          break;
        case "sign_in_with_apple":
          expect(await appleIdentityToken()).toBe(
            expectJs(fixture, "identityToken"),
          );
          break;
        case "storekit_current_entitlement":
          expect(await currentEntitlementJWS()).toBe(expectJs(fixture, "jws"));
          break;
        case "storekit_environment":
          // Apple's rawValue has a third value nobody writes: an Xcode-run
          // build reports "Xcode", which folds to Production here.
          expect(await appEnvironment()).toBe(
            expectJs(fixture, "appEnvironment"),
          );
          break;
        case "storekit_products":
          expect(await subscriptionProducts()).toStrictEqual(
            expectJs(fixture, "products"),
          );
          break;
        case "storekit_purchase":
          expect(await purchaseJWS(fixture.request!.productId as string)).toBe(
            expectJs(fixture, "jws"),
          );
          break;
        default:
          throw new Error(
            `${fixture.file}: no sync reader claims surface "${fixture.surface}" — add a case`,
          );
      }
    });
  }
});
