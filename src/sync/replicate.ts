import PouchDB from "pouchdb-browser";

import { db } from "../storage/db";
import type { Credentials, SyncStatus } from "./types";

/**
 * PouchDB replication against the pilot's CouchDB.
 *
 * Deliberately knows nothing about StoreKit, Apple, or the engine: it is handed
 * credentials and told when to pause. That keeps it drivable from the browser
 * ring with no native anything, which is where sync is actually tested.
 */

let handle: PouchDB.Replication.Sync<object> | null = null;
let remote: PouchDB.Database | null = null;
let held: Credentials | null = null;
let paused = false;
let status: SyncStatus = { state: "off" };
let lastSyncedAt: number | null = null;

const listeners = new Set<() => void>();

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function syncStatus(): SyncStatus {
  return status;
}

function set(next: SyncStatus) {
  status = next;
  for (const listener of listeners) listener();
}

function teardown() {
  handle?.cancel();
  handle = null;
  remote = null;
}

/**
 * True once a push was rejected while we believed we were entitled.
 *
 * PouchDB emits `denied` for a 403 and carries on: the doc is dropped from the
 * batch and the checkpoint advances past it. Measured against a real CouchDB —
 * push into a rejecting validate_doc_update, then grant the write role and push
 * again: docs_read 0, last_seq unchanged, doc still absent. It is never retried.
 *
 * This is invisible in most PouchDB apps, which is why it reads as wrong:
 * where documents are MUTABLE, a denied doc gets edited later, that edit lands
 * at a new seq past the checkpoint, and the whole thing self-heals unnoticed.
 * Flights are immutable after landing (STEERING), so their seq never comes
 * round again and nothing ever re-pushes them. Same library, opposite outcome —
 * the data model is what turns a quirk into permanent loss.
 *
 * backfill() is the second chance.
 */
let needsBackfill = false;

/**
 * Re-push everything, ignoring the checkpoint.
 *
 * `checkpoint: false` genuinely re-scans from the start rather than merely
 * skipping the checkpoint WRITE — verified against a real CouchDB: the same
 * push that read 0 docs with a checkpoint reads and writes the skipped doc
 * without one. One-shot and cheap: a logbook is hundreds of docs, and the
 * server rejects nothing it already has.
 */
async function backfill(target: PouchDB.Database) {
  needsBackfill = false;
  try {
    await db.replicate.to(target, { checkpoint: false });
  } catch {
    // Left for the next entitled connect; the local copy is the truth meanwhile.
    needsBackfill = true;
  }
}

function connect() {
  if (!held || paused) return;

  remote ??= new PouchDB(`${held.url}/${held.dbName}`, {
    auth: { username: held.username, password: held.password },
    // Replication is a convenience, not the source of truth — every flight is
    // already durable locally. Never let it hang a foreground request.
    skip_setup: true,
  });
  const target = remote;

  set({ state: "connecting" });

  // Pull-only when the subscription has lapsed. The server would 403 a push
  // anyway; mirroring its answer means a lapsed pilot sees "read-only", not a
  // stream of errors. Their flights keep coming DOWN — that is the promise.
  const options = { live: true, retry: true } as const;
  const pullOnly = !held.entitled;

  if (!pullOnly && needsBackfill) void backfill(target);

  const sync = pullOnly ? null : db.sync(target, options);
  handle = (sync ??
    db.replicate.from(
      target,
      options,
    )) as unknown as PouchDB.Replication.Sync<object>;

  const readOnly = pullOnly;
  const idle = () => set({ state: "syncing", lastSyncedAt, readOnly });

  handle
    .on("change", () => {
      lastSyncedAt = Date.now();
      idle();
    })
    .on("active", idle)
    .on("denied", (error: unknown) => {
      // The paywall and our idea of it disagree — the subscription lapsed while
      // we were running. Stop pushing into a wall, and remember to re-push the
      // dropped docs once entitlement returns, because the checkpoint has
      // already moved past them and PouchDB will never retry them on its own.
      if (held) held.entitled = false;
      needsBackfill = true;
      set({ state: "error", message: `write denied: ${String(error)}` });
      teardown();
      connect();
    })
    .on("error", (error: unknown) => {
      set({ state: "error", message: String(error) });
    });

  // `paused` fires on idle AND on a dropped network, and only the sub-
  // replications carry the error that tells them apart: Sync's forwarders emit
  // a bare `paused` with no argument (index.es.js:10401-10412). Listening on
  // the Sync object would report a dead network as a healthy idle, forever.
  //
  // .push/.pull are real (index.es.js:10369-10370) but missing from
  // @types/pouchdb-core, so the cast is narrowed to exactly that gap.
  const sub = sync as unknown as {
    push: PouchDB.Replication.Replication<object>;
    pull: PouchDB.Replication.Replication<object>;
  } | null;
  const sources = sub ? [sub.push, sub.pull] : [handle];
  for (const source of sources) {
    source.on("paused", (error?: unknown) => {
      if (error) set({ state: "error", message: String(error) });
      else idle();
    });
  }
}

export function start(credentials: Credentials) {
  held = credentials;
  teardown();
  connect();
}

export function stop() {
  held = null;
  lastSyncedAt = null;
  teardown();
  set({ state: "off" });
}

/**
 * Recording outranks sync, always.
 *
 * A live replication holds an open _changes connection and wakes the radio;
 * flights only reach PouchDB at finalization, so during a session that traffic
 * buys nothing and spends battery against the one invariant that matters. The
 * engine drives this — see sync/index.ts.
 */
export function setPaused(next: boolean) {
  if (paused === next) return;
  paused = next;

  if (paused) {
    teardown();
    if (held) set({ state: "paused" });
  } else {
    connect();
  }
}

export function isPaused(): boolean {
  return paused;
}
