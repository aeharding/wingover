import { describe, expect, it } from "vitest";

import { SEVERED_IDB, shouldHeal } from "./idbHeal";

describe("severed-IndexedDB heal", () => {
  it("matches both WebKit spellings of a severed session, and not a quota error", () => {
    expect(
      SEVERED_IDB.test(
        "InvalidStateError: Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.",
      ),
    ).toBe(true);
    expect(
      SEVERED_IDB.test(
        "UnknownError: Connection to Indexed Database server lost. Refresh the page to try again",
      ),
    ).toBe(true);
    expect(SEVERED_IDB.test("QuotaExceededError: quota exceeded")).toBe(false);
  });

  it("heals at most once per cooldown window", () => {
    const now = 1_700_000_000_000;
    expect(shouldHeal(0, now)).toBe(true);
    expect(shouldHeal(now - 1_000, now)).toBe(false);
    expect(shouldHeal(now - 60_000, now)).toBe(true);
  });
});
