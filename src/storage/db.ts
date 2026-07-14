import PouchDB from "pouchdb-browser";

import type { Fix } from "../engine/types";
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
}

export const db = new PouchDB("wingover", {
  auto_compaction: true,
  revs_limit: 25,
});

function flightDocId(flightId: string): string {
  return `flight:${flightId}`;
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

export async function saveFlight(flight: Flight, fixes: Fix[]) {
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
    _attachments: {
      [TRACK_ATTACHMENT]: {
        content_type: "application/gzip",
        data: await gzip(JSON.stringify(fixes)),
      },
    },
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

export async function getTrack(flightId: string): Promise<Fix[]> {
  try {
    const attachment = await db.getAttachment(
      flightDocId(flightId),
      TRACK_ATTACHMENT,
    );
    return JSON.parse(await gunzip(attachment as Blob | Buffer)) as Fix[];
  } catch {
    return [];
  }
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

export async function getSetting(key: string): Promise<string | null> {
  try {
    const doc = await db.get<{ value: string }>(`setting:${key}`);
    return doc.value;
  } catch {
    return null;
  }
}

export async function setSetting(key: string, value: string) {
  const _id = `setting:${key}`;
  try {
    const existing = await db.get(_id);
    await db.put({ ...existing, value });
  } catch {
    await db.put({ _id, value });
  }
}

// The settings store is string-valued; booleans cross that edge HERE and
// nowhere else — callers never see (or mis-parse) "false".
export async function getBooleanSetting(
  key: string,
  fallback: boolean,
): Promise<boolean> {
  const value = await getSetting(key);
  return value === null ? fallback : value === "true";
}

export async function setBooleanSetting(key: string, value: boolean) {
  await setSetting(key, value ? "true" : "false");
}
