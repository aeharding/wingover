import PouchDB from "pouchdb-browser";

import { syncedDb } from "../storage/db";
import type { Credentials, SyncAccount, SyncStatus } from "./types";

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

// The active-sync spinner rests on a settle timer, not a live doc count.
// PouchDB's per-batch `pending` was meant to tell a between-batch breather
// from truly caught up, but in a live replication the final batch's
// `pending` never reliably reaches 0 (and a bidirectional sync's two
// directions clobber a shared count), so the spinner stuck on "syncing"
// forever after everything had landed — the flake reported on-device. Now
// any wire activity marks busy, and the spinner rests only once the quiet
// has HELD this long; any change in the window cancels the rest.
let activeSettleTimer: ReturnType<typeof setTimeout> | null = null;
const ACTIVE_SETTLE_MS = 1500;

function clearActiveSettle() {
  if (activeSettleTimer !== null) {
    clearTimeout(activeSettleTimer);
    activeSettleTimer = null;
  }
}

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

/**
 * Memoized on the credential reference, not rebuilt per call:
 * useSyncExternalStore compares snapshots with Object.is, so a fresh object
 * every call would re-render forever. Every place `held` changes (start, stop,
 * the denied downgrade) also notifies subscribers via set(), so the UI re-reads
 * this at the right moments without this module knowing the UI exists.
 */
let accountFor: Credentials | null = null;
let account: SyncAccount | null = null;

export function currentAccount(): SyncAccount | null {
  if (held !== accountFor) {
    accountFor = held;
    account = held
      ? {
          kind: held.kind,
          entitled: held.entitled,
          login: held.login,
        }
      : null;
  }
  return account;
}

/**
 * Amends the held credential in place (e.g. appleLinked flipping true the
 * moment a link succeeds), persists it through the sink, and notifies so
 * currentAccount rebuilds. Not for anything replication keys off (url,
 * password) — those need a restart, not a patch.
 */
export function patchCredentials(patch: Partial<Credentials>) {
  if (!held) return;
  held = { ...held, ...patch };
  onCredentialsChanged?.(held);
  set(status);
}

function set(next: SyncStatus) {
  // Any state change cancels a tentative "rest the spinner" timer, so a
  // pending idle can never fire late and clobber a later error/off/busy.
  clearActiveSettle();
  status = next;
  for (const listener of listeners) listener();
}

function teardown() {
  clearActiveSettle();
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
    await syncedDb().replicate.to(target, { checkpoint: false });
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
    return "Too many failed attempts. The server locked this account; wait five minutes, then turn sync on again.";
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

  const sync = pullOnly ? null : syncedDb().sync(target, options);
  handle = (sync ??
    syncedDb().replicate.from(
      target,
      options,
    )) as unknown as PouchDB.Replication.Sync<object>;

  const readOnly = pullOnly;

  const idle = () =>
    set({ state: "syncing", lastSyncedAt, readOnly, active: false });
  // Docs on the wire (`active` opens a burst, `change` lands each batch):
  // the UI spins, immediately.
  const busy = () =>
    set({ state: "syncing", lastSyncedAt, readOnly, active: true });
  // `paused` fires between every batch of a bulk pull AND when truly caught
  // up, so it cannot rest the spinner directly without flickering the whole
  // way down. Instead it arms a delayed rest: a change/active inside the
  // window cancels it (via set()), so the spinner holds through the pull and
  // stops for good only once the quiet actually lasts.
  const settle = () => {
    clearActiveSettle();
    activeSettleTimer = setTimeout(idle, ACTIVE_SETTLE_MS);
  };

  handle
    .on("change", () => {
      lastSyncedAt = Date.now();
      busy();
    })
    .on("active", busy)
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
      // A 404 on an unentitled credential is the sign-in-born account: the
      // server provisions the database at FIRST entitlement (SYNC-UX.md), so
      // until the pilot subscribes there is genuinely nothing to sync — a
      // resting state, not a problem to display.
      const status = (error as { status?: number } | null)?.status;
      if (status === 404 && held && !held.entitled) {
        set({ state: "unsubscribed" });
        teardown();
        return;
      }
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
      // An error here is NOT a problem, and calling it one was a lie the pilot
      // could see: `paused` carries a bare "Failed to fetch" (no status —
      // measured) every time the live _changes long-poll is aborted, which
      // happens on any reconnect, teardown or blip. The status flashed red and
      // healed itself seconds later, which is exactly how an indicator teaches
      // you to ignore it.
      //
      // retry:true means the library WILL come back, so there is nothing for
      // the pilot to do and nothing to announce. "Last synced 10:32" is already
      // the honest answer to "are my flights backed up?" — it goes stale on its
      // own if this keeps failing, without ever crying wolf. Only a rejected
      // credential is a real problem, and that arrives on `error`.
      if (!error) settle();
    });
  }
}

/**
 * The pre-logout flush: one non-live push, so "everything is on the server"
 * is a fact this call just made true rather than a hope. False means it
 * could NOT be proven: no credential, a lapse (the server 403s pushes), a
 * rejected doc, or a network too slow to answer — the caller warns before
 * destroying anything local. Bounded, because a dead network must not hang
 * logout: past the timeout the push is cancelled and reads as unproven.
 * Builds its own target when replication is torn down (paused, error), so
 * the flush still runs from any resting state that holds a credential.
 */
export async function flushPush(timeoutMs = 8000): Promise<boolean> {
  if (!held || !held.entitled) return false;
  const target =
    remote ??
    new PouchDB(`${held.url}/${held.dbName}`, {
      auth: { username: held.username, password: held.password },
      skip_setup: true,
    });
  const push = syncedDb().replicate.to(target);
  const timer = setTimeout(() => push.cancel(), timeoutMs);
  try {
    const result = await push;
    return (
      result.ok === true &&
      result.status !== "cancelled" &&
      (result.doc_write_failures ?? 0) === 0
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
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
