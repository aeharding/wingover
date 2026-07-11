import type { Fix, Waypoint } from "./types";

export interface WalSession {
  armedAt: number;
  takeoffIndex: number | null;
  landingIndex?: number | null;
  landingDismissed?: boolean;
  // Journaled pilot intent (wall clock): a manual stop finalizes the
  // flight exactly like an expired landing grace — derived, durable,
  // collected by the same persist-first path.
  stoppedAt?: number | null;
  waypoints?: Waypoint[];
}

const DB_NAME = "wingover-wal";
const FIXES_STORE = "fixes";
const META_STORE = "meta";
const SESSION_KEY = "session";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore(FIXES_STORE, { autoIncrement: true });
      db.createObjectStore(META_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStores<T>(
  mode: IDBTransactionMode,
  run: (fixes: IDBObjectStore, meta: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction([FIXES_STORE, META_STORE], mode);
    const request = run(
      tx.objectStore(FIXES_STORE),
      tx.objectStore(META_STORE),
    );
    tx.oncomplete = () => {
      db.close();
      resolve(request ? request.result : (undefined as T));
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function readWal(): Promise<{
  session: WalSession | null;
  fixes: Fix[];
}> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([FIXES_STORE, META_STORE], "readonly");
    const fixesRequest = tx.objectStore(FIXES_STORE).getAll();
    const sessionRequest = tx.objectStore(META_STORE).get(SESSION_KEY);
    tx.oncomplete = () => {
      db.close();
      resolve({
        session: (sessionRequest.result as WalSession | undefined) ?? null,
        fixes: (fixesRequest.result as Fix[]) ?? [],
      });
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export function writeWalSession(session: WalSession): Promise<void> {
  return withStores("readwrite", (_fixes, meta) => {
    meta.put(session, SESSION_KEY);
  });
}

// One transaction per batch: burst replay (foregrounding after hours
// backgrounded, the simulator at high compression) delivers thousands of
// fixes in moments, and a transaction per fix makes the queue drain take
// longer than the flight.
export function appendWalFixes(batch: Fix[]): Promise<void> {
  return withStores("readwrite", (fixes) => {
    for (const fix of batch) fixes.add(fix);
  });
}

export function clearWal(): Promise<void> {
  return withStores("readwrite", (fixes, meta) => {
    fixes.clear();
    meta.clear();
  });
}
