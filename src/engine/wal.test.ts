import { IDBDatabase, IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

describe("readWal failure", () => {
  const realTransaction = IDBDatabase.prototype.transaction;

  afterEach(() => {
    IDBDatabase.prototype.transaction = realTransaction;
  });

  // Boot waits on this promise: an aborted read must reject (with a real
  // Error, never a bare null) or the app never renders anything at all.
  it("rejects with an Error when the read transaction aborts", async () => {
    await writeWalSession({ armedAt: 1, takeoffIndex: null });
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = realTransaction.apply(this, args);
      queueMicrotask(() => tx.abort());
      return tx;
    };
    await expect(readWal()).rejects.toBeInstanceOf(Error);
  });
});
