import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";

import { readWal, type WalSession, writeWalSession } from "./wal";

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

describe("WalSession round-trip", () => {
  // W1 — the new nav intent fields persist and read back intact.
  it("round-trips ad-hoc waypoints (with addedAtIndex) and removedIds", async () => {
    const session: WalSession = {
      armedAt: 1,
      takeoffIndex: 0,
      waypoints: [
        { id: "a", latitude: 43.03, longitude: -89.4, radiusM: 321.8688 },
      ],
      adhocWaypoints: [
        {
          id: "x",
          latitude: 43.01,
          longitude: -89.4,
          radiusM: 321.8688,
          addedAtIndex: 7,
        },
      ],
      removedIds: ["a"],
    };
    await writeWalSession(session);
    const read = (await readWal()).session;
    expect(read?.adhocWaypoints?.[0].addedAtIndex).toBe(7);
    expect(read?.adhocWaypoints?.[0].id).toBe("x");
    expect(read?.removedIds).toEqual(["a"]);
  });

  // W2 — absent fields hydrate as undefined (the engine's `?? []` handles them).
  it("hydrates absent ad-hoc/removed fields as undefined", async () => {
    await writeWalSession({ armedAt: 1, takeoffIndex: 0, waypoints: [] });
    const read = (await readWal()).session;
    expect(read?.adhocWaypoints).toBeUndefined();
    expect(read?.removedIds).toBeUndefined();
  });
});

// The read the whole boot waits on (src/engine/bootGate.ts). A transaction
// that aborts fires "abort" and NOT "error", so the read has to handle it
// itself or its promise never settles — and a launch that could have
// answered in milliseconds instead sits out the gate's entire deadline
// showing a dark screen.
describe("readWal always settles", () => {
  it("rejects when the transaction aborts after its requests are done", async () => {
    await writeWalSession({ armedAt: 1, takeoffIndex: 0, waypoints: [] });

    // Aborted from the LAST request's success, so every request of the read
    // is already done: nothing is left to fire an error event, and "abort"
    // is the only event the transaction will ever emit. (A store evicted
    // mid-read, a WKWebView whose IndexedDB is severed by a Settings trip.)
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore["get"]>
    ) {
      const request = get.apply(this, args);
      request.addEventListener("success", () => request.transaction?.abort());
      return request;
    };

    try {
      const outcome = await Promise.race([
        readWal().then(
          () => "resolved",
          () => "rejected",
        ),
        new Promise((resolve) => setTimeout(() => resolve("hung"), 500)),
      ]);
      expect(outcome).toBe("rejected");
    } finally {
      IDBObjectStore.prototype.get = get;
    }
  });
});
