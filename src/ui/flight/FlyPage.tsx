import {
  closeOutline,
  compassOutline,
  locateOutline,
  locationOutline,
  stop as stopIcon,
} from "ionicons/icons";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { engine } from "../../engine";
import { isTauri } from "../../engine/platform";
import { startFlight } from "../../engine/session";
import type { EngineStatus, Fix, LngLat, Waypoint } from "../../engine/types";
import {
  formatAltitude,
  formatClimb,
  formatCourse,
  formatDistance,
  formatDuration,
  formatRelativeDegrees,
  formatSpeed,
} from "../../flight/format";
import { LANDING_GRACE_MS } from "../../flight/landing";
import { bearingBetween, relativeBearing } from "../../flight/nav";
import { computeStats, haversineMeters } from "../../flight/stats";
import {
  inheritedLaunchName,
  listPins,
  onDocsChanged,
  type Pin,
  saveFlight,
} from "../../storage/db";
import NativeIcon from "../components/NativeIcon";
import type { MapViewKind } from "../map/config";
import type { MapView } from "../map/types";
import ViewToggle from "../map/ViewToggle";
import { useSettings } from "../settings/SettingsContext";
import { useBigConfirm } from "./BigConfirm";
import LiveTrackMap from "./LiveTrackMap";
import Tile from "./Tile";
import { showToast } from "./toast";
import { useLiveViewPrefs } from "./useLiveViewPrefs";

import "./FlyPage.css";

// WAL hydration happens once per app launch. The App swaps the whole nav shell
// for a bare <FlyPage> when a flight is active, so FlyPage remounts mid-session
// (the moment a flight starts, and again when it ends). Seeding `ready` from
// this module flag keeps that remount from flashing the pre-hydration blank —
// the engine is already hydrated by then.
let hydratedOnce = false;

// Locking the phone is only safe where the native layer records through
// it (background location); the PWA is foreground-only.
const ACQUIRING_HINT = isTauri()
  ? "Make sure you're in an open, unobstructed area. It's safe to lock your phone."
  : "Make sure you're in an open, unobstructed area.";

const ARMED_HINT = isTauri()
  ? "Recording starts automatically when you launch. It's safe to lock your phone."
  : "Recording starts automatically when you launch.";

export default function FlyPage() {
  const { units } = useSettings();
  // The engine is the single owner of flight state; this page is a view.
  // Snapshots are cached (stable identity between changes) and the change
  // signal is coalesced per task, so a replay burst lands as one render of
  // a complete track — there is no per-fix mirror to fall behind.
  const snapshot = useSyncExternalStore(engine.subscribe, engine.snapshotSync);
  // Hydration gate: before the WAL read the engine reports "idle", which
  // must not flash the Start button during a live-flight reload.
  const [ready, setReady] = useState(hydratedOnce);
  const { confirm: bigConfirm, element: confirmElement } = useBigConfirm();
  const {
    mapView,
    follow,
    trackUp,
    update: updateLiveView,
  } = useLiveViewPrefs();
  const [liveMap, setLiveMap] = useState<MapView | null>(null);
  const [mapTopInset, setMapTopInset] = useState(0);
  // The planned route, for the idle-screen distance. Reloaded on every entry
  // to the Fly tab so edits made on the Plan tab are reflected.
  const [plannedPins, setPlannedPins] = useState<Pin[]>([]);
  // Loaded on mount and then LIVE: edits on the Plan tab, or a synced
  // pull from another device, land here through the store's own feed. No
  // shell lifecycle involved; the flight surface subscribes directly.
  useEffect(() => {
    void listPins().then(setPlannedPins);
    return onDocsChanged("pin", () => void listPins().then(setPlannedPins));
  }, []);
  // The waypoint the pilot tapped on the map — gates the "clear checkpoint"
  // control. Held as an id; the live active set decides whether it still exists.
  const [selectedWaypointId, setSelectedWaypointId] = useState<string | null>(
    null,
  );
  const instrumentsRef = useRef<HTMLDivElement>(null);

  const { track, latest, landingAt, nextWaypoint, error: gpsError } = snapshot;
  // Only a still-active selection surfaces the control; a reached/removed pin
  // drops out of activeWaypoints and the button hides on its own.
  const selectedWaypoint =
    snapshot.activeWaypoints.find((w) => w.id === selectedWaypointId) ?? null;
  const status: EngineStatus | "loading" = ready ? snapshot.status : "loading";

  function changeMapView(value: MapViewKind) {
    updateLiveView({ mapView: value });
  }

  function changeFollow(value: boolean) {
    // Unsnapping drops track-up WITH it: resuming is two deliberate
    // presses (snap, then compass), never one button silently re-enabling
    // a second mode.
    updateLiveView(
      value ? { follow: true } : { follow: false, trackUp: false },
    );
  }

  function changeTrackUp(value: boolean) {
    updateLiveView({ trackUp: value });
  }

  async function persistFlight(flown: Fix[], plannedWaypoints: Waypoint[]) {
    if (flown.length <= 1) return;
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
    const launchName = await inheritedLaunchName(launchAt).catch(
      () => undefined,
    );
    try {
      await saveFlight(
        {
          // Deterministic id: re-running collection after a crash between
          // save and WAL-clear must not duplicate the flight.
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
        },
        flown,
      );
    } catch (error) {
      if ((error as { name?: string }).name !== "conflict") throw error;
    }
    // Body-level and imperative (see toast.ts): it survives this
    // component unmounting the instant the flight ends and the nav shell
    // swaps back in.
    showToast("Flight saved to logbook");
  }

  // "ended" is a durable state: the finalized flight waits in the WAL.
  // Persist first, discard after — a crash in between just repeats this
  // on next launch, and the deterministic flight id makes it idempotent.
  const collectEndedFlight = useEffectEvent(async () => {
    const snapshot = await engine.getSnapshot();
    if (snapshot.status !== "ended") return;
    await persistFlight(snapshot.track, snapshot.waypoints);
    // Persisted — the engine's durable copy can go; idle follows.
    await engine.discard();
  });

  useEffect(() => {
    // Kick the one-time WAL hydration; the subscription picks up the
    // resulting state change like any other.
    void engine.getSnapshot().then(() => {
      hydratedOnce = true;
      setReady(true);
    });
  }, []);

  // A flight that ended — now, or while the app was away (durable "ended"
  // hydrated from the WAL) — is collected the moment the view sees it.
  // Deferred a tick: collection drives the engine (persist, stop), it does
  // not synchronize render state.
  useEffect(() => {
    if (status !== "ended") return;
    void Promise.resolve().then(() => collectEndedFlight());
  }, [status]);

  useLayoutEffect(() => {
    if (status !== "recording" && status !== "landed") return;
    const measure = () =>
      setMapTopInset(
        instrumentsRef.current?.getBoundingClientRect().height ?? 0,
      );
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [status]);

  async function armFlight() {
    changeFollow(true);
    changeTrackUp(false);
    await startFlight();
  }

  async function cancelArmed() {
    await engine.discard();
  }

  // Journal the stop; the flight derives to "ended" and the collection
  // effect persists it — the same crash-safe path as a detected landing.
  function endFlight() {
    engine.end();
  }

  // An explicit confirm beats the old long-press: nothing about a hold
  // gesture is discoverable mid-flight, and a stray tap must not end a
  // recording. The same reasoning covers the pre-launch Cancel button — a
  // mistap while acquiring GPS or waiting for takeoff would silently miss
  // the launch — so it reuses this exact dialog. Before takeoff there's
  // nothing recorded to finalize (end() no-ops until launch), so the
  // confirmed action discards the un-launched session instead of ending.
  // The landing prompt's own button stays direct — it IS the confirmation
  // there.
  function confirmEndFlight() {
    const stop =
      status === "acquiring" || status === "armed" ? cancelArmed : endFlight;
    bigConfirm({ title: "End flight?", action: "Stop", onAction: stop });
  }

  function dismissLandingPrompt() {
    engine.dismissLanding();
  }

  const landingSecondsLeft =
    landingAt !== null && latest
      ? Math.max(
          0,
          Math.ceil((LANDING_GRACE_MS - (latest.timestamp - landingAt)) / 1000),
        )
      : 0;

  const first = track[0];
  const durationSeconds =
    latest && first && (status === "recording" || status === "landed")
      ? (latest.timestamp - first.timestamp) / 1000
      : 0;
  // Total planned-route length = sum of the legs between consecutive pins.
  const plannedRouteMeters =
    plannedPins.length >= 2
      ? plannedPins.reduce(
          (sum, pin, i) =>
            i === 0 ? 0 : sum + haversineMeters(plannedPins[i - 1], pin),
          0,
        )
      : 0;
  // Nav points at the next waypoint whenever a route target remains, and
  // falls back to the launch point once the route is exhausted (nextWaypoint
  // null). Same distance/bearing math either way.
  const navTarget = nextWaypoint ?? first ?? null;
  const navLabel = nextWaypoint ? "waypoint" : "launch";
  const toTargetDistance =
    latest && navTarget ? haversineMeters(latest, navTarget) : 0;
  const toTargetRelative =
    latest && navTarget
      ? relativeBearing(latest.course, bearingBetween(latest, navTarget))
      : 0;

  return (
    <div className="fly-content">
      {status === "idle" && (
        <div className="fly-idle">
          <button className="start-button" onClick={armFlight}>
            Start Flight
          </button>
          {plannedRouteMeters > 0 && (
            <div className="planned-route" data-testid="planned-route">
              Planned route: {formatDistance(plannedRouteMeters, units)}
            </div>
          )}
          {gpsError && (
            <div className="gps-error" data-testid="gps-error">
              {gpsError.message}
            </div>
          )}
        </div>
      )}
      {(status === "acquiring" || status === "armed") && (
        <div className="fly-armed" data-testid="armed">
          <div className="armed-message">
            <div
              className={status === "armed" ? "pulse" : "pulse acquiring"}
              aria-hidden="true"
            />
            <h2>
              {status === "acquiring" ? "Acquiring GPS" : "Waiting for takeoff"}
            </h2>
            <p>{status === "acquiring" ? ACQUIRING_HINT : ARMED_HINT}</p>
          </div>
          {gpsError && (
            <div className="gps-error" data-testid="gps-error">
              {gpsError.message}
            </div>
          )}
          {status === "acquiring" ? (
            <div className="armed-accuracy" data-testid="armed-accuracy">
              {latest
                ? `±${formatAltitude(latest.horizontalAccuracy, units)} H · ±${formatAltitude(latest.verticalAccuracy, units)} V`
                : "—"}
            </div>
          ) : (
            <div className="armed-speed" data-testid="armed-speed">
              {latest ? formatSpeed(latest.speed, units) : "—"}
            </div>
          )}
          <button className="cancel-button" onClick={confirmEndFlight}>
            Cancel
          </button>
        </div>
      )}
      {(status === "recording" || status === "landed") && (
        <div className="fly-recording" data-testid="recording">
          <div className="instruments" ref={instrumentsRef}>
            <Tile
              label="Above launch"
              value={
                latest && first
                  ? formatAltitude(latest.altitude - first.altitude, units)
                  : "—"
              }
              accent="cyan"
              testId="instrument-agl"
            />
            <Tile
              label="Duration"
              value={formatDuration(durationSeconds)}
              testId="instrument-duration"
            />
            <Tile
              label="Altitude MSL"
              value={latest ? formatAltitude(latest.altitude, units) : "—"}
              testId="instrument-msl"
            />
            <Tile
              label="Climb rate"
              value={latest ? formatClimb(latest.climbRate, units) : "—"}
              testId="instrument-climb"
            />
            <Tile
              label="Ground speed"
              value={latest ? formatSpeed(latest.speed, units) : "—"}
              accent="green"
              testId="instrument-speed"
            />
            <Tile
              label={`Distance to ${navLabel}`}
              value={
                latest && navTarget
                  ? formatDistance(toTargetDistance, units)
                  : "—"
              }
              accent="green"
              testId="instrument-target-distance"
            />
            <Tile
              label="Course"
              value={latest ? formatCourse(latest.course) : "—"}
              icon={latest ? <Compass course={latest.course} /> : undefined}
              accent="yellow"
              testId="instrument-course"
            />
            <Tile
              label={`Direction to ${navLabel}`}
              value={
                latest && navTarget
                  ? formatRelativeDegrees(toTargetRelative)
                  : "—"
              }
              icon={
                latest && navTarget ? (
                  <span
                    className="launch-arrow"
                    style={{ rotate: `${toTargetRelative}deg` }}
                    aria-hidden="true"
                  >
                    {/* The same chevron as the map's blue location arrow,
                          so "direction to launch" reads as an obvious
                          pointer, not a thin glyph. */}
                    <svg viewBox="-8 -11 16 20" className="launch-arrow-svg">
                      <polygon points="0,-10 7,8 0,4 -7,8" />
                    </svg>
                  </span>
                ) : undefined
              }
              accent="yellow"
              testId="instrument-target-direction"
            />
          </div>
          <LiveTrackMap
            track={track}
            latest={latest}
            view={mapView}
            follow={follow}
            trackUp={trackUp}
            topInset={mapTopInset}
            plannedWaypoints={snapshot.waypoints}
            navWaypoints={snapshot.activeWaypoints}
            onMapReady={setLiveMap}
            onAddWaypoint={(at) => {
              // Long-press: the new ad-hoc point becomes the next target;
              // tap it then clear if it was a mistap.
              void engine.addAdhocWaypoint(at);
            }}
            onSelectWaypoint={(id) => {
              // Only the next waypoint — the current target — can be selected
              // to clear. A tap on any other pin (or a deselect) clears.
              setSelectedWaypointId(id === nextWaypoint?.id ? id : null);
            }}
            onFollowChange={changeFollow}
          />
          {gpsError && (
            <div
              className="gps-error recording-error"
              style={{ top: mapTopInset + 12 }}
              data-testid="gps-error"
            >
              {gpsError.message}
            </div>
          )}
          <div className="flight-controls">
            {/* Contextual: floats ABOVE the fixed control grid (which is
                  bottom-anchored) so appearing/disappearing never nudges the
                  four regular controls out of their fixed positions. */}
            {selectedWaypoint && (
              <button
                className="map-button skip-button"
                aria-label="Clear selected waypoint"
                data-testid="remove-waypoint"
                onClick={() => {
                  void engine.removeWaypoint(selectedWaypoint.id);
                  setSelectedWaypointId(null);
                }}
              >
                {/* A location pin with a small trash badge: "delete this
                      selected checkpoint". */}
                <span className="skip-icon" aria-hidden="true">
                  <span className="skip-icon-pin">
                    <NativeIcon icon={locationOutline} />
                  </span>
                  <NativeIcon className="skip-icon-badge" icon={closeOutline} />
                </span>
              </button>
            )}
            {/* The app-wide cluster cells (.map-cluster): this page IS
                the reference layout the replay hosts mirror. Explicit
                cells also pin stop to BR on builds without satellite
                (flow order used to slide it into globe's cell). */}
            <div className="map-cluster">
              <button
                className="map-button map-cell-tl"
                aria-label={follow ? "Track up" : "Align north"}
                // The mode light shows only while the mode is in
                // effect (unsnapping also clears the pref; the gate
                // guards any future unsnap path that forgets to).
                data-active={follow && trackUp}
                onClick={() => {
                  if (follow) {
                    changeTrackUp(!trackUp);
                    return;
                  }
                  // Unsnapped, the compass is a north reset: bearing
                  // zero, immediately, mode untouched. No animation,
                  // ever, in flight. Always present — a control that
                  // comes and goes is worse than one that occasionally
                  // has nothing to do.
                  liveMap?.moveTo({ bearing: 0 }, { animate: false });
                }}
              >
                <NativeIcon icon={compassOutline} />
              </button>
              <button
                className="map-button map-cell-tr"
                aria-label="Follow aircraft"
                data-active={follow}
                // A toggle: pressing while snapped unsnaps (and takes
                // track-up down with it, via changeFollow).
                onClick={() => changeFollow(!follow)}
              >
                <NativeIcon icon={locateOutline} />
              </button>
              {liveMap?.supportsSatellite && (
                <div className="map-cell-bl">
                  <ViewToggle view={mapView} onChange={changeMapView} />
                </div>
              )}
              <button
                className="map-button stop-button map-cell-br"
                aria-label="Stop flight"
                onClick={confirmEndFlight}
              >
                <NativeIcon icon={stopIcon} />
              </button>
            </div>
          </div>
          {status === "landed" && landingAt !== null && (
            /* Same surface as the end-flight confirm (BigConfirm's
                 classes): one dialog language in flight. The scrim is the
                 safe answer, like Cancel there. */
            <div
              className="big-confirm"
              role="presentation"
              data-testid="landing-prompt"
              onClick={dismissLandingPrompt}
            >
              <div
                className="big-confirm-panel"
                role="alertdialog"
                aria-modal="true"
                aria-label="Landing detected"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="big-confirm-title">Landing detected</div>
                <div className="big-confirm-actions">
                  <button
                    className="big-confirm-cancel"
                    onClick={dismissLandingPrompt}
                  >
                    Still flying
                  </button>
                  <button className="big-confirm-action" onClick={endFlight}>
                    Stop
                    {snapshot.autoEnd ? ` (${landingSecondsLeft})` : ""}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
      {confirmElement}
    </div>
  );
}

function Compass({ course }: { course: number }) {
  return (
    <svg className="compass" viewBox="0 0 44 44" aria-hidden="true">
      <circle cx="22" cy="22" r="20.5" />
      <text x="22" y="8.5">
        N
      </text>
      <text x="36" y="22">
        E
      </text>
      <text x="22" y="35.5">
        S
      </text>
      <text x="8" y="22">
        W
      </text>
      <g transform={`rotate(${course} 22 22)`}>
        <polygon className="needle-north" points="22,9 25.5,24 22,21 18.5,24" />
        <polygon
          className="needle-south"
          points="22,35 18.5,20 22,23 25.5,20"
        />
      </g>
    </svg>
  );
}
