import { computeStats } from "../flight/stats";
import { WAYPOINT_RADIUS_M } from "../flight/waypoints";
import {
  type Flight,
  inheritedLaunchName,
  listPins,
  type Pin,
  saveFlight,
} from "../storage/db";
import { getDetectLanding } from "../storage/local";
import { engine } from "./index";
import type { Fix, LngLat, Waypoint } from "./types";

// Foreground recovery, wired HERE and not in a component (STEERING:
// anything that must happen regardless of which page is mounted is wired
// engine-side): coming back from Settings must PROCEED, not sit on a
// frozen screen. This is the one place the app learns it was away, and
// after a Settings trip it is usually the only evidence there is: a
// refused watch is a dead one, so nothing else is left to notice. (The
// imprecise takeover is the exception — it keeps its watch running so a
// good fix can disprove it.)
//
// What a foreground costs is the source's business, not this file's:
// engine.retry() forwards to the source, which reruns a browser watch or
// asks CoreLocation once and reports what it finds. No platform check
// here (the seam lint forbids one, and that is exactly the point).
//
// It is also the retry for collection: a finalized flight whose save failed
// gets another attempt, and a foreground is the one event that is guaranteed
// to arrive afterwards. The engine has cleared its watch by then, so nothing
// else will wake this file again.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    engine.retry();
    collectWhenEnded();
  });
}

// Collection follows the engine, not the view, for the same reason. It used
// to live in the flight surface, which was mounted for the whole collection
// window because App.tsx sheds the shell for anything that is not "idle" —
// until an error boundary went in front of that surface. A crash it cannot
// heal replaces the surface with the crash screen, and collection went with
// it: discard() is the only transition to "idle", so the app pinned on
// "ended" with the flight stranded in the WAL, the crash screen permanent,
// and sync paused behind it.
engine.subscribe(collectWhenEnded);

// The one-time WAL hydration is kicked HERE for the same reason: boot must
// proceed no matter which page mounts first. The app root's gate only
// OBSERVES the outcome (engine.hydrationSync); no component owns the kick.
// A flight that ended while the app was away is durable "ended" the moment
// this read lands, so the boot path collects from the read itself rather than
// from the change signal that happens to follow it.
void engine.getSnapshot().then(collectWhenEnded);

/**
 * The flight that ended and has not been shown to the pilot yet, taken once.
 *
 * Not an event, not a subscription, and not persisted, because it needs to be
 * none of those. A flight can only end while the flight surface is up, and the
 * discard below is what flips the engine to "idle" and mounts the ground shell
 * — so the shell always mounts AFTER this is written, in the same page load,
 * and a plain read on mount cannot miss it. That timing is precisely what the
 * old push had to fight: it fired at the instant the two trees swapped, so it
 * belonged to neither and lived on <body> in imperative DOM to survive.
 *
 * A FAILED handover is not here because it is not a completion: the engine
 * stays on "ended" and collection retries. There is nothing to announce.
 *
 * An id, not the record: the logbook is the source of truth for what a flight
 * IS, and a summary screen would go there anyway.
 */
let endedFlightId: string | null = null;

export function consumeEndedFlight(): string | null {
  const id = endedFlightId;
  endedFlightId = null;
  return id;
}

// "ended" is a durable state: the finalized flight waits in the WAL.
// Persist first, discard after — a crash in between just repeats this on
// the next signal or launch, and the deterministic flight id makes it
// idempotent.
//
// Serialized by this flag rather than by the caller: every engine change
// signal lands here, and two overlapping collections would race one save
// against the discard of the flight it is still reading.
let collecting = false;

/**
 * Whether the last collection attempt failed, and a way for the one surface
 * that can show it to hear about it.
 *
 * Its own signal rather than engine state: a save that fails is the storage
 * layer's problem, not a flight state, and the engine's status has no business
 * growing a member for it. The engine stays on "ended" either way, which is
 * what keeps the flight safe.
 */
let collectionFailed = false;
const collectionListeners = new Set<() => void>();

export function subscribeCollection(listener: () => void): () => void {
  collectionListeners.add(listener);
  return () => {
    collectionListeners.delete(listener);
  };
}

export function collectionFailedSync(): boolean {
  return collectionFailed;
}

/**
 * The pilot asking again. The automatic retries (foreground, next launch) do
 * not reach someone who simply keeps looking at the screen.
 */
export function retryCollection(): void {
  collectWhenEnded();
}

function setCollectionFailed(value: boolean): void {
  if (collectionFailed === value) return;
  collectionFailed = value;
  collectionListeners.forEach((listener) => listener());
}

function collectWhenEnded() {
  if (engine.snapshotSync().status !== "ended") return;
  void collectEndedFlight();
}

async function collectEndedFlight(): Promise<void> {
  if (collecting) return;
  collecting = true;
  try {
    const snapshot = await engine.getSnapshot();
    if (snapshot.status !== "ended") return;
    let flight: Flight | null = null;
    try {
      flight = await persistFlight(snapshot.track, snapshot.waypoints);
    } catch (error) {
      // Not silent: "ended" owns a surface now (SavingSurface), and this flag
      // is what turns it from "Saving flight" into something the pilot can act
      // on. STEERING requires a finalization failure to surface loudly on the
      // ring where the WAL is the only copy, and this is that ring. Nothing is
      // lost either way — the WAL still holds the flight and the engine stays
      // on "ended", so a foreground, a relaunch, or Try Again collects it.
      console.error("flight persist failed:", error);
      setCollectionFailed(true);
      return;
    }
    setCollectionFailed(false);
    // Set BEFORE the discard: the discard is what mounts the shell that reads
    // it. A reload landing in that gap costs the pilot a toast, never a
    // flight — the logbook already has it.
    if (flight) endedFlightId = flight.id;
    // Persisted — the engine's durable copy can go; idle follows. A
    // rejection here is post-persistence cleanup (the flight is already
    // in the logbook), so it must NOT light the collection failure
    // signal: that screen would claim an unsaved flight, and the flag is
    // sticky until the NEXT successful persist. The leftover WAL
    // re-collects on the next boot as a no-op save.
    await engine.discard().catch((error: unknown) => {
      console.error("wal clear failed:", error);
    });
  } finally {
    collecting = false;
  }
}

// null means there was no flight in the session to save (armed, never flew).
// The engine's copy is released either way; only a THROW keeps it.
async function persistFlight(
  flown: Fix[],
  plannedWaypoints: Waypoint[],
): Promise<Flight | null> {
  if (flown.length <= 1) return null;
  const startedAt = flown[0].timestamp;
  // The planned pins ([lng, lat], in order) so the flight detail map can
  // draw the grey optimal-path line alongside the flown track.
  const plannedRoute: LngLat[] = plannedWaypoints.map((w) => [
    w.longitude,
    w.latitude,
  ]);
  const launchAt: LngLat = [flown[0].longitude, flown[0].latitude];
  // The label is decorative; the save is sacred. A failed logbook read
  // must never block persisting the flight (STEERING: no recoverable
  // failure loses track data) — an error here just means no name today.
  const launchName = await inheritedLaunchName(launchAt).catch(() => undefined);
  const flight: Flight = {
    // Deterministic id: re-running collection after a crash between save and
    // WAL-clear must not duplicate the flight.
    id: `recorded-${startedAt}`,
    // No minted name: a display default baked into storage reads as
    // something the pilot typed, and every surface then needs
    // string-matching to un-bake it. Empty means "untitled"; the UI
    // falls back launch site, then date (flightTitle).
    name: "",
    notes: "",
    startedAt,
    stats: computeStats(flown),
    updatedAt: Date.now(),
    launchAt,
    launchName,
    ...(plannedRoute.length > 0 ? { plannedRoute } : {}),
  };
  try {
    await saveFlight(flight, flown);
  } catch (error) {
    if ((error as { name?: string }).name !== "conflict") throw error;
  }
  return flight;
}

// Pins are planning documents; waypoints are anonymous geofence config.
// This projection is the only place one becomes the other — deliberately
// field-by-field so pin data (name, notes, whatever comes later) never
// crosses into the session or the native waypoints file.
function toWaypoint(pin: Pin): Waypoint {
  return {
    id: pin.id,
    latitude: pin.latitude,
    longitude: pin.longitude,
    radiusM: WAYPOINT_RADIUS_M,
  };
}

// Starting a flight copies the plan into the session: the Plan tab is a
// reusable template for the NEXT flight; an active flight owns its
// waypoints and never re-reads the plan (STEERING.md).
export async function startFlight(): Promise<void> {
  const [pins, detectLanding] = await Promise.all([
    listPins(),
    getDetectLanding(),
  ]);
  await engine.start({
    waypoints: pins.map(toWaypoint),
    // The session copies the setting at start, like the waypoint plan:
    // an active flight keeps the behavior it took off with.
    detectLanding,
  });
}
