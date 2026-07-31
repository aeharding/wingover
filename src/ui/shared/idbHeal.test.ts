import { describe, expect, it } from "vitest";

import { describeRejection, nextCount, SEVERED_IDB } from "./idbHeal";

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

  it("reads the severed signature out of PouchDB's wrapper", () => {
    const wrapped = Object.assign(new Error("unknown"), {
      name: "indexed_db_went_bad",
      reason:
        "Connection to Indexed Database server lost. Refresh the page to try again",
    });
    expect(SEVERED_IDB.test(describeRejection(wrapped))).toBe(true);
    const quota = Object.assign(new Error("unknown"), {
      name: "indexed_db_went_bad",
      reason: "QuotaExceededError",
    });
    expect(SEVERED_IDB.test(describeRejection(quota))).toBe(false);
  });

  it("terminal count: two heals in the window, then the module stops", () => {
    const now = 1_700_000_000_000;
    const first = nextCount(null, now);
    expect(first.allowed).toBe(true);
    const second = nextCount(first.next, now + 61_000);
    expect(second.allowed).toBe(true);
    const third = nextCount(second.next, now + 122_000);
    expect(third.allowed).toBe(false);
    // A fresh window resets the count.
    const later = nextCount(second.next, now + 11 * 60_000);
    expect(later.allowed).toBe(true);
  });
});
