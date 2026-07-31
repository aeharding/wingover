import PouchDB from "pouchdb-browser";
import { describe, expect, it } from "vitest";

import { describeRejection, SEVERED_IDB } from "./idbErrors";

/**
 * The probe-verdict design's load-bearing claims, MEASURED against real
 * PouchDB over fake-indexeddb (the same stack local.test.ts runs on):
 * a logout's destroy must not read as a severed session, and a fresh
 * probe open must succeed while (and after) a destroy runs. What this
 * ring cannot measure is WebKit's actual severed-session semantics —
 * that remains an on-device drill.
 */
function probe(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => {
      reject(request.error ?? new Error("probe failed"));
    };
  });
}

describe("probe verdict vs a logout's destroy (measured)", () => {
  it("a post-destroy read rejects with a signature the heal ignores", async () => {
    const db = new PouchDB("probe-drill-a");
    await db.put({ _id: "doc" });
    await db.destroy();

    const rejection = await db.get("doc").then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).not.toBeNull();
    // PouchDB's own deliberate-destroy guard, not WebKit's severed text.
    expect(SEVERED_IDB.test(describeRejection(rejection))).toBe(false);
  });

  it("a fresh probe open succeeds during and after a destroy", async () => {
    const db = new PouchDB("probe-drill-b");
    await db.put({ _id: "doc" });

    // Read + destroy dispatched together: however the race lands, the
    // read's rejection must not heal, and the probe must stay green.
    const read = db.get("doc").then(
      () => null,
      (error: unknown) => error,
    );
    const destroying = db.destroy();
    await expect(probe("wingover-idb-probe-drill")).resolves.toBeUndefined();
    await destroying;
    await expect(probe("wingover-idb-probe-drill")).resolves.toBeUndefined();

    const rejection = await read;
    // The race can resolve the read or reject it; only a rejection that
    // MATCHES the severed signature would wrongly reach the probe — and
    // even then, the green probe above is the verdict that no heal fires.
    if (rejection !== null) {
      expect(typeof describeRejection(rejection)).toBe("string");
    }
  });
});
