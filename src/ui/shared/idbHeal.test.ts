import { describe, expect, it } from "vitest";

import { describeRejection, SEVERED_IDB } from "./idbHeal";

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
});
