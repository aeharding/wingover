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
      waypoints: [{ id: "a", latitude: 43.03, longitude: -89.4, radiusM: 321.8688 }],
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
