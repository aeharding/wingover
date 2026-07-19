import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { Credentials } from "./types";

// ── Replication harness ─────────────────────────────────────────────────────
// replicate.ts talks to exactly two collaborators — the local PouchDB
// (`syncedDb`) and a remote one (`new PouchDB`) — and its whole state machine is
// driven by the events those replications emit (change / active / paused /
// denied / error). Neither collaborator is reachable from the test ring, and
// there was no way to hand-drive those events, so the entire `connect()` state
// machine shipped untested — which is how an entitled pilot got stranded on
// "Not subscribed" (a `denied` on `_design/auth`, misread as a lapse).
//
// This fakes both: the fake local hands back controllable EventEmitters, and the
// test emits `change`/`paused`/`denied`/`error` by hand, then asserts on the
// public status. `kit.seen` captures what connect() built so a test can grab the
// live handle and the replication options (to check the `_design` filter).
const kit = vi.hoisted(() => {
  interface Emitter {
    on(ev: string, cb: (arg?: unknown) => void): Emitter;
    emit(ev: string, arg?: unknown): void;
    cancel(): void;
    cancelled: boolean;
    push?: Emitter;
    pull?: Emitter;
  }

  const makeEmitter = (): Emitter => {
    const handlers: Record<string, Array<(arg?: unknown) => void>> = {};
    const e: Emitter = {
      cancelled: false,
      on(ev, cb) {
        (handlers[ev] ??= []).push(cb);
        return e;
      },
      emit(ev, arg) {
        for (const cb of handlers[ev] ?? []) cb(arg);
      },
      cancel() {
        e.cancelled = true;
      },
    };
    return e;
  };

  const seen = {
    sync: null as Emitter | null, // bidirectional handle (entitled)
    syncOpts: null as Record<string, unknown> | null,
    pull: null as Emitter | null, // replicate.from handle (pull-only / lapsed)
    toOpts: [] as Array<Record<string, unknown> | undefined>, // replicate.to (backfill)
  };

  const fakeLocal = {
    sync(_target: unknown, opts: Record<string, unknown>) {
      const h = makeEmitter();
      h.push = makeEmitter();
      h.pull = makeEmitter();
      seen.sync = h;
      seen.syncOpts = opts;
      return h;
    },
    replicate: {
      from() {
        const h = makeEmitter();
        seen.pull = h;
        return h;
      },
      to(_target: unknown, opts?: Record<string, unknown>) {
        seen.toOpts.push(opts);
        const p = Promise.resolve({ ok: true }) as Promise<{ ok: boolean }> & {
          cancel(): void;
        };
        p.cancel = () => {};
        return p;
      },
    },
  };

  return {
    fakeLocal,
    seen,
    reset() {
      seen.sync = null;
      seen.syncOpts = null;
      seen.pull = null;
      seen.toOpts = [];
    },
  };
});

vi.mock("pouchdb-browser", () => ({
  default: class {
    constructor(public url: string) {}
  },
}));
vi.mock("../storage/db", () => ({ syncedDb: () => kit.fakeLocal }));

import * as replicate from "./replicate";

const entitled: Credentials = {
  kind: "apple",
  url: "https://db.example",
  dbName: "sandbox-userdb-x",
  username: "x",
  password: "p",
  entitled: true,
  login: null,
  environment: "Sandbox",
};
const lapsed: Credentials = { ...entitled, entitled: false };

// SyncStatus is a union; widen it for reading in assertions.
const status = () =>
  replicate.syncStatus() as {
    state: string;
    lastSyncedAt?: number | null;
    readOnly?: boolean;
    active?: boolean;
    message?: string;
  };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-19T12:00:00Z"));
  replicate.setPaused(false); // clear a leftover recording-pause from a prior test
  replicate.setCredentialSink(() => {});
  replicate.stop();
  kit.reset();
});

afterEach(() => {
  replicate.stop();
  vi.useRealTimers();
});

describe("connect: entitled vs lapsed shape", () => {
  test("an entitled credential syncs bidirectionally and backfills once", () => {
    replicate.start(entitled);
    expect(kit.seen.sync).not.toBeNull();
    expect(kit.seen.pull).toBeNull();
    expect(kit.seen.toOpts).toHaveLength(1); // the checkpoint-free backfill push
    expect(status().state).toBe("connecting");
  });

  test("a lapsed credential replicates pull-only: no push, no backfill", () => {
    replicate.start(lapsed);
    expect(kit.seen.pull).not.toBeNull();
    expect(kit.seen.sync).toBeNull();
    expect(kit.seen.toOpts).toHaveLength(0);

    kit.seen.pull!.emit("change");
    expect(status().readOnly).toBe(true);
  });
});

describe("_design docs never cross the wire (regression: #90 root cause)", () => {
  test("the live sync filter drops _design and keeps flights", () => {
    replicate.start(entitled);
    const filter = kit.seen.syncOpts!.filter as (d: { _id: string }) => boolean;
    expect(filter({ _id: "_design/auth" })).toBe(false);
    expect(filter({ _id: "recorded-1700000000000" })).toBe(true);
  });

  test("the backfill push carries the same filter", () => {
    replicate.start(entitled);
    const filter = kit.seen.toOpts[0]!.filter as (d: { _id: string }) => boolean;
    expect(filter({ _id: "_design/auth" })).toBe(false);
    expect(filter({ _id: "recorded-1" })).toBe(true);
  });
});

describe("denied handling (regression: entitled pilots stuck on 'Not subscribed')", () => {
  test("a _design/auth denial does NOT lapse the subscription", () => {
    replicate.start(entitled);
    const handle = kit.seen.sync!;
    kit.reset();

    handle.emit("denied", { id: "_design/auth", error: "forbidden" });

    expect(replicate.currentAccount()?.entitled).toBe(true);
    expect(kit.seen.pull).toBeNull(); // no drop to pull-only
    expect(kit.seen.sync).toBeNull(); // no teardown + reconnect
  });

  test("a _design denial reported via doc._id is also ignored", () => {
    replicate.start(entitled);
    kit.seen.sync!.emit("denied", { doc: { _id: "_design/auth" } });
    expect(replicate.currentAccount()?.entitled).toBe(true);
  });

  test("a real flight-doc denial drops to read-only, persists it, reconnects pull-only", () => {
    const sink = vi.fn();
    replicate.setCredentialSink(sink);
    replicate.start(entitled);

    kit.seen.sync!.emit("denied", { id: "recorded-1", error: "forbidden" });

    expect(replicate.currentAccount()?.entitled).toBe(false);
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ entitled: false }),
    );
    expect(kit.seen.pull).not.toBeNull(); // reconnected pull-only
  });
});

describe("catch-up stamps lastSyncedAt (regression: 'Waiting for changes')", () => {
  test("a clean paused stamps lastSyncedAt once the spinner settles", () => {
    replicate.start(entitled);
    expect(status().lastSyncedAt).toBeFalsy();

    kit.seen.sync!.push!.emit("paused"); // no error = caught up
    vi.advanceTimersByTime(1500); // settle timer → idle()

    expect(status().state).toBe("syncing");
    expect(status().lastSyncedAt).toBeTruthy();
  });

  test("a paused carrying an error (a dropped longpoll) does not stamp", () => {
    replicate.start(entitled);
    kit.seen.sync!.push!.emit("paused", new Error("Failed to fetch"));
    vi.advanceTimersByTime(1500);
    expect(status().lastSyncedAt).toBeFalsy();
  });
});

describe("error handling", () => {
  test("a 404 on a lapsed credential rests on 'unsubscribed', not an error", () => {
    replicate.start(lapsed);
    kit.seen.pull!.emit("error", { status: 404 });
    expect(status().state).toBe("unsubscribed");
  });

  test("a rejected password (401) lands on 'error'", () => {
    replicate.start(entitled);
    kit.seen.sync!.emit("error", { status: 401, reason: "unauthorized" });
    expect(status().state).toBe("error");
  });
});

describe("change events", () => {
  test("a change marks busy and stamps lastSyncedAt", () => {
    replicate.start(entitled);
    kit.seen.sync!.emit("change");
    expect(status().state).toBe("syncing");
    expect(status().active).toBe(true);
    expect(status().lastSyncedAt).toBeTruthy();
  });
});

describe("lifecycle", () => {
  test("stop() cancels the live handle and rests on 'off'", () => {
    replicate.start(entitled);
    const handle = kit.seen.sync!;
    replicate.stop();
    expect(handle.cancelled).toBe(true);
    expect(status().state).toBe("off");
  });

  test("setPaused tears sync down for 'paused' and reconnects on resume", () => {
    replicate.start(entitled);
    const handle = kit.seen.sync!;

    // Recording outranks sync: a live flight must not hold the radio open.
    replicate.setPaused(true);
    expect(handle.cancelled).toBe(true);
    expect(status().state).toBe("paused");

    kit.reset();
    replicate.setPaused(false);
    expect(kit.seen.sync).not.toBeNull(); // flight over → reconnected
  });

  test("subscribe hears status changes; unsubscribe stops it", () => {
    const fn = vi.fn();
    const unsub = replicate.subscribe(fn);
    replicate.start(entitled); // set({ connecting })
    expect(fn).toHaveBeenCalled();

    const before = fn.mock.calls.length;
    unsub();
    replicate.stop(); // set({ off }) — no longer heard
    expect(fn.mock.calls.length).toBe(before);
  });
});

describe("flushPush (the pre-logout proof)", () => {
  test("returns false without an entitled credential", async () => {
    replicate.start(lapsed);
    expect(await replicate.flushPush()).toBe(false);
  });

  test("pushes and proves success for an entitled credential", async () => {
    replicate.start(entitled);
    expect(await replicate.flushPush()).toBe(true);
  });
});
