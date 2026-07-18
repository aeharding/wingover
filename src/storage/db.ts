import PouchDB from "pouchdb-browser";

import type { Fix, LngLat } from "../engine/types";
import { type FlightStats, haversineMeters } from "../flight/stats";

export interface Flight {
  id: string;
  name: string;
  notes: string;
  startedAt: number;
  stats: FlightStats;
  updatedAt: number;
  source?: string;
  sourceFilename?: string;
  importBatchId?: string;
  importedAt?: number;
  // The planned pins ([lng, lat], in order) copied at takeoff, for drawing
  // the grey optimal-path reference on the flight detail map. Absent for
  // flights recorded without a plan and for imported flights.
  plannedRoute?: LngLat[];
  // Where the flight started ([lng, lat]) and what the pilot calls that
  // place. The name is per-flight and editable; new flights copy it from
  // the nearest previous named launch (inheritedLaunchName), so the logbook
  // itself is the site register — no separate sites collection. Both absent
  // on flights recorded before the fields existed.
  launchAt?: LngLat;
  launchName?: string;
}

export interface Pin {
  id: string;
  name: string;
  notes: string;
  latitude: number;
  longitude: number;
  createdAt: number;
  updatedAt: number;
}

const TRACK_ATTACHMENT = "track.json.gz";

interface FlightDoc {
  _id: string;
  _rev?: string;
  name: string;
  notes: string;
  startedAt: number;
  stats: FlightStats;
  updatedAt: number;
  source?: string;
  sourceFilename?: string;
  importBatchId?: string;
  importedAt?: number;
  plannedRoute?: LngLat[];
  launchAt?: LngLat;
  launchName?: string;
}

/**
 * The synced store: flights and pins, and nothing else.
 *
 * Everything in here replicates to a pilot's other devices once sync is on, so
 * anything device-local belongs in storage/local.ts instead.
 */
function open() {
  return new PouchDB("wingover", {
    auto_compaction: true,
    revs_limit: 25,
  });
}

let db = open();

/**
 * The live handle, read at call time. Consumers outside this module call
 * this per use and never cache the result: resetSyncedData() swaps the
 * instance under a logged-out web session, and a cached handle is a
 * permanently dead database — the bug that used to force a full page
 * reload on logout.
 */
export function syncedDb(): PouchDB.Database {
  return db;
}

function flightDocId(flightId: string): string {
  return `flight:${flightId}`;
}

// Sorts outside the flight: range, so listFlights never sees these.
function trackDocId(flightId: string): string {
  return `track:${flightId}`;
}

function toFlight(doc: FlightDoc): Flight {
  return {
    id: doc._id.replace(/^flight:/, ""),
    name: doc.name,
    notes: doc.notes,
    startedAt: doc.startedAt,
    stats: doc.stats,
    updatedAt: doc.updatedAt,
    source: doc.source,
    sourceFilename: doc.sourceFilename,
    importBatchId: doc.importBatchId,
    importedAt: doc.importedAt,
    plannedRoute: doc.plannedRoute,
    launchAt: doc.launchAt,
    launchName: doc.launchName,
  };
}

async function gzip(text: string): Promise<Blob> {
  const stream = new Blob([text])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).blob();
}

async function gunzip(data: Blob | Buffer): Promise<string> {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart]);
  const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

/**
 * Metadata and track are separate documents on purpose.
 *
 * PouchDB's push replication re-sends a document's attachments on every
 * revision of that document — the digest check that would skip unchanged bytes
 * only runs when pulling FROM a remote (pouchdb 9.0.0,
 * getDocAttachmentsFromTargetOrSource). So with the track attached to the
 * flight, renaming a flight re-uploaded the whole track: ~275KB for a two-hour
 * recording, every edit. Splitting them means a rename replicates a few hundred
 * bytes and the track — immutable once landed — is sent exactly once, ever.
 *
 * Track first: a failure then leaves an orphan track doc that nothing lists,
 * and the caller sees the throw with the WAL still holding the flight. The
 * other order would leave a flight visible in the logbook with no track, which
 * looks exactly like data loss.
 */
export async function saveFlight(flight: Flight, fixes: Fix[]) {
  try {
    await db.put({
      _id: trackDocId(flight.id),
      _attachments: {
        [TRACK_ATTACHMENT]: {
          content_type: "application/gzip",
          data: await gzip(JSON.stringify(fixes)),
        },
      },
    });
  } catch (error) {
    // Already there: a retry after the track landed but the metadata didn't.
    // A track is immutable, so the existing one is the same bytes — throwing
    // here would wedge the retry that is supposed to rescue the flight.
    if ((error as { status?: number }).status !== 409) throw error;
  }
  await db.put({
    _id: flightDocId(flight.id),
    name: flight.name,
    notes: flight.notes,
    startedAt: flight.startedAt,
    stats: flight.stats,
    updatedAt: flight.updatedAt,
    source: flight.source,
    sourceFilename: flight.sourceFilename,
    importBatchId: flight.importBatchId,
    importedAt: flight.importedAt,
    plannedRoute: flight.plannedRoute,
    launchAt: flight.launchAt,
    launchName: flight.launchName,
  });
}

/**
 * UI reactivity: one live changes feed, started on first subscriber, fanned
 * out by doc-id prefix ("flight" / "pin" / "track"). It fires for local
 * writes AND replicated pulls alike — which is what makes a flight landing
 * from another device appear in the logbook without a refresh. Coalesced
 * with a short timer: replication delivers in batches, and one re-render per
 * batch is plenty.
 */
type DocPrefix = "flight" | "track" | "pin";
const changeListeners = new Map<DocPrefix, Set<() => void>>();
let changesFeed: PouchDB.Core.Changes<object> | null = null;

function ensureChangesFeed() {
  if (changesFeed) return;
  changesFeed = db.changes({ since: "now", live: true });
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  changesFeed
    .on("change", (change) => {
      pending.add(change.id.split(":")[0] ?? "");
      timer ??= setTimeout(() => {
        timer = null;
        const prefixes = [...pending];
        pending.clear();
        for (const prefix of prefixes) {
          const listeners = changeListeners.get(prefix as DocPrefix);
          if (listeners) for (const listener of listeners) listener();
        }
      }, 50);
    })
    .on("error", () => {
      // A dead feed silently stops notifying forever; let the next
      // subscription (or the next call here) start a fresh one.
      changesFeed = null;
    });
}

export function onDocsChanged(
  prefix: DocPrefix,
  listener: () => void,
): () => void {
  ensureChangesFeed();
  let listeners = changeListeners.get(prefix);
  if (!listeners) {
    listeners = new Set();
    changeListeners.set(prefix, listeners);
  }
  listeners.add(listener);
  const set = listeners;
  return () => {
    set.delete(listener);
  };
}

/**
 * Web log-out: the local copy leaves with the pilot (shared computers).
 *
 * Destroy, then reopen, in that order: both handles would point at the
 * same IndexedDB name, so opening the replacement first hands back the
 * old data and then destroys it out from under the new handle. The feed
 * is rebuilt on the fresh instance and every subscriber notified at the
 * end, so lists re-read (empty) in place — logout never reloads the page.
 */
export async function resetSyncedData(): Promise<void> {
  changesFeed?.cancel();
  changesFeed = null;
  await db.destroy();
  db = open();
  if (changeListeners.size > 0) ensureChangesFeed();
  for (const listeners of changeListeners.values()) {
    for (const listener of listeners) listener();
  }
}

/**
 * One-time heal, run at every boot: recorded flights used to be born
 * with the display default baked into `name` ("Flight " + the locale
 * datetime), which every surface then had to un-bake. Strips exactly the
 * string this device would have minted; a pilot's own name can never
 * match. Every boot rather than a done-flag, because sync can pull an
 * un-healed copy in from another device (or a phone still on the old
 * build) at any time; the pass is a metadata read over a few hundred
 * docs. Locale caveat: a default minted under another locale reads as a
 * custom name and survives, which shows a stale title instead of ever
 * deleting something typed.
 */
export async function stripMintedFlightNames(): Promise<void> {
  const result = await db.allDocs<FlightDoc>({
    include_docs: true,
    startkey: "flight:",
    endkey: "flight:\ufff0",
  });
  for (const row of result.rows) {
    const doc = row.doc;
    if (!doc) continue;
    if (doc.name === `Flight ${new Date(doc.startedAt).toLocaleString()}`) {
      await db.put({ ...doc, name: "" });
    }
  }
}

export async function listFlights(): Promise<Flight[]> {
  const result = await db.allDocs<FlightDoc>({
    include_docs: true,
    startkey: "flight:",
    endkey: "flight:￰",
  });
  return result.rows
    .flatMap((row) => (row.doc ? [toFlight(row.doc as FlightDoc)] : []))
    .sort((a, b) => b.startedAt - a.startedAt);
}

export async function getFlight(flightId: string): Promise<Flight | null> {
  try {
    return toFlight(await db.get<FlightDoc>(flightDocId(flightId)));
  } catch {
    return null;
  }
}

async function readTrack(docId: string): Promise<Fix[] | null> {
  try {
    const attachment = await db.getAttachment(docId, TRACK_ATTACHMENT);
    return JSON.parse(await gunzip(attachment as Blob | Buffer)) as Fix[];
  } catch {
    return null;
  }
}

export async function getTrack(flightId: string): Promise<Fix[]> {
  // Flights recorded before the track was split still carry it on the flight
  // doc. Falling back costs one miss on those and nothing on new ones — and
  // real test flights are precious enough (STEERING) not to drop for tidiness.
  return (
    (await readTrack(trackDocId(flightId))) ??
    (await readTrack(flightDocId(flightId))) ??
    []
  );
}

export async function updateFlight(
  flightId: string,
  changes: Partial<Pick<Flight, "name" | "notes" | "launchName" | "launchAt">>,
) {
  const doc = await db.get<FlightDoc>(flightDocId(flightId));
  await db.put({ ...doc, ...changes, updatedAt: Date.now() });
}

/**
 * How close two launches must be to count as the same place. Sized to a
 * flying field, not a region: far enough to absorb GPS scatter and laying
 * out on the other end of the same field, near enough that the next farm
 * over stays its own place.
 */
const SAME_LAUNCH_METERS = 300;

export interface NamedLaunch {
  at: LngLat;
  name: string;
}

/**
 * Every named launch in the logbook, newest flight first (listFlights
 * order). Loaded once and matched many times by batch import — per-file
 * loads made a 1000-file import spend more time naming flights than
 * saving them.
 */
export async function namedLaunches(): Promise<NamedLaunch[]> {
  return (await listFlights()).flatMap((flight) =>
    flight.launchAt && flight.launchName
      ? [{ at: flight.launchAt, name: flight.launchName }]
      : [],
  );
}

/** Newest-first input makes this most-recent-wins, so renaming a flight's
 * launch propagates forward to future flights without rewriting past ones. */
export function nearestLaunchName(
  launches: NamedLaunch[],
  launchAt: LngLat,
): string | undefined {
  const here = { longitude: launchAt[0], latitude: launchAt[1] };
  return launches.find(
    (launch) =>
      haversineMeters(here, {
        longitude: launch.at[0],
        latitude: launch.at[1],
      }) <= SAME_LAUNCH_METERS,
  )?.name;
}

/**
 * The launch name a new flight at this point should carry, from the pilot's
 * own history.
 */
export async function inheritedLaunchName(
  launchAt: LngLat,
): Promise<string | undefined> {
  return nearestLaunchName(await namedLaunches(), launchAt);
}

export async function deleteFlight(flightId: string) {
  const doc = await db.get(flightDocId(flightId));
  await db.remove(doc);
  // The track is a separate document now; deleting only the metadata would
  // strand a few hundred KB per flight, invisibly, forever. Tolerated absence:
  // flights recorded before the split have no track doc to remove.
  try {
    const track = await db.get(trackDocId(flightId));
    await db.remove(track);
  } catch {
    // Nothing to remove.
  }
}

interface PinDoc {
  _id: string;
  _rev?: string;
  name: string;
  notes: string;
  latitude: number;
  longitude: number;
  createdAt: number;
  updatedAt: number;
}

function pinDocId(pinId: string): string {
  return `pin:${pinId}`;
}

function toPin(doc: PinDoc): Pin {
  return {
    id: doc._id.replace(/^pin:/, ""),
    name: doc.name,
    notes: doc.notes,
    latitude: doc.latitude,
    longitude: doc.longitude,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export async function savePin(pin: Pin) {
  await db.put({
    _id: pinDocId(pin.id),
    name: pin.name,
    notes: pin.notes,
    latitude: pin.latitude,
    longitude: pin.longitude,
    createdAt: pin.createdAt,
    updatedAt: pin.updatedAt,
  });
}

export async function listPins(): Promise<Pin[]> {
  const result = await db.allDocs<PinDoc>({
    include_docs: true,
    startkey: "pin:",
    endkey: "pin:￰",
  });
  return result.rows
    .flatMap((row) => (row.doc ? [toPin(row.doc as PinDoc)] : []))
    .sort((a, b) => a.createdAt - b.createdAt);
}

export async function updatePin(
  pinId: string,
  changes: Partial<Pick<Pin, "name" | "notes" | "latitude" | "longitude">>,
) {
  const doc = await db.get<PinDoc>(pinDocId(pinId));
  await db.put({ ...doc, ...changes, updatedAt: Date.now() });
}

export async function deletePin(pinId: string) {
  const doc = await db.get(pinDocId(pinId));
  await db.remove(doc);
}

