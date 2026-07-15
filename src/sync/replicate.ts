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

/**
 * How a credential change gets back to the store. A callback rather than an
 * import, because this module stays store-free (see the header) — and because
 * the alternative is what the bug below actually was.
 */
let onCredentialsChanged: ((credentials: Credentials) => void) | null = null;

export function setCredentialSink(sink: (credentials: Credentials) => void) {
  onCredentialsChanged = sink;
}

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
 * Whether this process has already run its one checkpoint-free push.
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
 * This used to be a `needsBackfill` flag set by the `denied` handler, which
 * could never fire: the handler drops us to pull-only in the same tick, and the
 * only consumer is the entitled path. The flag's whole reason for existing is a
 * lapse that ends LATER — a renewal the next day, a fresh process, module state
 * long gone. So there is no flag to lose: the first entitled connect of every
 * process simply backfills. It is one-shot and cheap either way.
 */
let backfilled = false;

/**
 * Re-push everything, ignoring the checkpoint.
 *
 * `checkpoint: false` genuinely re-scans from the start rather than merely
 * skipping the checkpoint WRITE — verified against a real CouchDB: the same
 * push that read 0 docs with a checkpoint reads and writes the skipped doc
 * without one. Cheap: revs_diff means only what the server lacks crosses the
 * wire, and a logbook is hundreds of docs.
 */
async function backfill(target: PouchDB.Database) {
  backfilled = true;
  try {
    await db.replicate.to(target, { checkpoint: false });
  } catch {
    // Next launch tries again; the local copy is the truth meanwhile.
    backfilled = false;
  }
}

/**
 * A rejected credential, turned into words the pilot can act on.
 *
 * This is about the message, and the scope is deliberately small. Measured
 * against CouchDB 3.5.2: `retry: true` does NOT hammer a 401 — the handshake
 * burst fails within ~700ms and PouchDB stops on its own, so nothing here is
 * saving anyone from a retry storm. The preflight in providers/manual.ts is
 * what saves the pilot from a lockout, by never making the burst at all (~7
 * parallel auth failures against a threshold of 5 locks the account, whatever
 * this function does afterwards).
 *
 * What it does: name the failure. Without it the pilot's status reads as a raw
 * PouchDB error object, and a lockout is indistinguishable from a bad password
 * — which matters, because the remedies are opposites (wait vs. retype).
 *
 * A per-document 403 from validate_doc_update is NOT this: it arrives on
 * `denied`, means "lapsed subscription", and is handled there.
 */
function fatalAuthFailure(error: unknown): string | null {
  const status = (error as { status?: number } | null | undefined)?.status;
  if (status !== 401 && status !== 403) return null;
  const reason = String(
    (error as { reason?: string; message?: string })?.reason ??
      (error as { message?: string })?.message ??
      "",
  );
  if (/locked/i.test(reason)) {
    return "Too many failed attempts — the server locked this account. Wait five minutes, then turn sync on again.";
  }
  return status === 401
    ? "The server rejected this device's password. Turn sync off and connect again."
    : "The server refused access to this database.";
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

  if (!pullOnly && !backfilled) void backfill(target);

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
    .on("denied", () => {
      // The paywall and our idea of it disagree — the subscription lapsed while
      // we were running. Drop to pull-only rather than push into a wall.
      //
      // Persisted, not just mutated: `held` is a snapshot the store already
      // JSON.stringify'd, so an in-place `held.entitled = false` left disk
      // saying `true`, and every launch during the lapse would start a full
      // push, burn another batch of flights past the checkpoint, and only then
      // downgrade. The next entitled connect backfills whatever was lost.
      if (!held) return;
      held = { ...held, entitled: false };
      onCredentialsChanged?.(held);
      teardown();
      connect();
    })
    .on("error", (error: unknown) => {
      // Where a rejected credential lands (measured — not `paused`, which is
      // where retry:true reports a stalled network).
      const fatal = fatalAuthFailure(error);
      set({ state: "error", message: fatal ?? String(error) });
      if (fatal) teardown();
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
  backfilled = false;
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
