import {
  IonContent,
  IonIcon,
  IonPage,
  useIonAlert,
  useIonToast,
  useIonViewWillEnter,
} from "@ionic/react";
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
import type {
  EngineStatus,
  Fix,
  LngLat,
  Waypoint,
} from "../../engine/types";
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
  type Pin,
  saveFlight,
} from "../../storage/db";
import { getSetting, setSetting } from "../../storage/local";
import Tile from "../components/Tile";
import type { MapViewKind } from "../map/config";
import LiveTrackMap from "../map/LiveTrackMap";
import { readLiveViewState, writeLiveViewState } from "../map/liveViewState";
import type { MapView } from "../map/types";
import ViewToggle from "../map/ViewToggle";
import { useSettings } from "../settings/SettingsContext";

import "./FlyPage.css";

const savedLiveView = readLiveViewState();

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
  const [presentAlert] = useIonAlert();
  const [presentToast] = useIonToast();
  const [mapView, setMapView] = useState<MapViewKind>(
    savedLiveView.mapView ?? "street",
  );
  const [follow, setFollow] = useState(savedLiveView.follow ?? true);
  const [liveMap, setLiveMap] = useState<MapView | null>(null);
  const [trackUp, setTrackUp] = useState(savedLiveView.trackUp ?? false);
  const [mapTopInset, setMapTopInset] = useState(0);
  // The planned route, for the idle-screen distance. Reloaded on every entry
  // to the Fly tab so edits made on the Plan tab are reflected.
  const [plannedPins, setPlannedPins] = useState<Pin[]>([]);
  useIonViewWillEnter(() => {
    listPins().then(setPlannedPins);
  });
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
    setMapView(value);
    setSetting("mapView", value);
    writeLiveViewState({ mapView: value });
  }

  function changeFollow(value: boolean) {
    setFollow(value);
    writeLiveViewState({ follow: value });
  }

  function changeTrackUp(value: boolean) {
    setTrackUp(value);
    writeLiveViewState({ trackUp: value });
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
          name: `Flight ${new Date(startedAt).toLocaleString()}`,
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
    // Imperative toast (useIonToast): it lives on the toast controller, not
    // this component, so it survives FlyPage unmounting the instant the flight
    // ends and the nav shell swaps back in.
    void presentToast({
      message: "Flight saved to logbook",
      color: "success",
      duration: 2000,
      position: "top",
    });
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
    getSetting("mapView").then((value) => {
      if (value === "street" || value === "satellite") setMapView(value);
    });
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
    presentAlert({
      header: "End flight?",
      buttons: [
        { text: "Cancel", role: "cancel" },
        { text: "Stop", role: "destructive", handler: stop },
      ],
    });
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
    <IonPage>
      <IonContent fullscreen scrollY={false} className="fly-content">
        {status === "idle" && (
          <div className="fly-idle">
            <IdleBackdrop />
            <h1>Wingover</h1>
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
                {status === "acquiring"
                  ? "Acquiring GPS"
                  : "Waiting for takeoff"}
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
                    <IonIcon icon={locationOutline} />
                    <IonIcon className="skip-icon-badge" icon={closeOutline} />
                  </span>
                </button>
              )}
              <div className="flight-controls-grid">
                <button
                  className="map-button"
                  aria-label="Track up"
                  data-active={trackUp}
                  onClick={() => changeTrackUp(!trackUp)}
                >
                  <IonIcon icon={compassOutline} />
                </button>
                <button
                  className="map-button"
                  aria-label="Follow aircraft"
                  data-active={follow}
                  onClick={() => changeFollow(true)}
                >
                  <IonIcon icon={locateOutline} />
                </button>
                {liveMap?.supportsSatellite && (
                  <ViewToggle view={mapView} onChange={changeMapView} />
                )}
                <button
                  className="map-button stop-button"
                  aria-label="Stop flight"
                  onClick={confirmEndFlight}
                >
                  <IonIcon icon={stopIcon} />
                </button>
              </div>
            </div>
            {status === "landed" && landingAt !== null && (
              <div className="landing-prompt" data-testid="landing-prompt">
                <div className="landing-message">Looks like you landed</div>
                <div className="landing-actions">
                  <button
                    className="landing-continue"
                    onClick={dismissLandingPrompt}
                  >
                    Still flying
                  </button>
                  <button className="landing-stop" onClick={endFlight}>
                    Stop
                    {snapshot.autoEnd ? ` (${landingSecondsLeft})` : ""}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </IonContent>
    </IonPage>
  );
}

// Ambient backdrop for the idle screen: the app icon (design/icon.svg)
// distilled to its motifs and reused VERBATIM — the exact canopy, fanned
// flight-path curves, sun, clouds and star, in the icon's own 1024
// coordinate space — recolored for a dark sky and rendered near-
// transparent. Reusing the designer's paths keeps the lines attached to
// the canopy exactly as the icon draws them. Star/clouds are nudged toward
// the center so the portrait slice doesn't crop them.
function IdleBackdrop() {
  return (
    <svg
      className="fly-idle-art"
      viewBox="0 0 1024 1024"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <circle className="idle-star" cx="322" cy="150" r="14" />
      <circle className="idle-star" cx="470" cy="86" r="9" />
      <rect className="idle-cloud" x="470" y="690" width="180" height="26" rx="13" />
      <rect className="idle-cloud" x="560" y="742" width="110" height="22" rx="11" />
      <circle className="idle-sun" cx="348" cy="812" r="135" />
      <g transform="translate(25 -20)">
        <g className="idle-lines" fill="none">
          <path d="M 103 927 Q 143 1014 213 1080" />
          <path d="M 185 856 Q 241 978 328 1080" />
          <path d="M 267 784 Q 335 941 435 1080" />
          <path d="M 348 713 Q 424 905 533 1080" />
          <path d="M 429 641 Q 510 868 624 1080" />
          <path d="M 510 569 Q 593 831 709 1080" />
          <path d="M 591 496 Q 823 734 1080 946" />
          <path d="M 671 424 Q 863 649 1080 849" />
          <path d="M 751 352 Q 902 557 1080 738" />
          <path d="M 832 279 Q 942 455 1080 609" />
          <path d="M 911 206 Q 981 343 1080 461" />
        </g>
        <path
          className="idle-canopy"
          transform="translate(10 -20)"
          d="M 60 935 A 1415 1415 0 0 1 1005 90 A 40198 40198 0 0 1 60 935 Z"
        />
      </g>
    </svg>
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
