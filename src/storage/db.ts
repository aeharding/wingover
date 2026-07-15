import PouchDB from "pouchdb-browser";

import type { Fix, LngLat } from "../engine/types";
import type { FlightStats } from "../flight/stats";

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
}

/**
 * The synced store: flights and pins, and nothing else.
 *
 * Everything in here replicates to a pilot's other devices once sync is on, so
 * anything device-local belongs in storage/local.ts instead.
 */
export const db = new PouchDB("wingover", {
  auto_compaction: true,
  revs_limit: 25,
});

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
  });
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
  changes: Partial<Pick<Flight, "name" | "notes">>,
) {
  const doc = await db.get<FlightDoc>(flightDocId(flightId));
  await db.put({ ...doc, ...changes, updatedAt: Date.now() });
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

