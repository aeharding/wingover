import { IonContent, IonIcon, IonPage, IonToast } from "@ionic/react";
import {
  compassOutline,
  locateOutline,
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
import type { EngineStatus, Fix } from "../../engine/types";
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
import { getSetting, saveFlight, setSetting } from "../../storage/db";
import Tile from "../components/Tile";
import type { MapViewKind } from "../map/config";
import LiveTrackMap from "../map/LiveTrackMap";
import { readLiveViewState, writeLiveViewState } from "../map/liveViewState";
import ViewToggle from "../map/ViewToggle";
import { useSettings } from "../settings/SettingsContext";

import "./FlyPage.css";

const initialSearch = location.search;

function durationParamMs(name: string, fallback: number): number {
  const raw = new URLSearchParams(initialSearch).get(name);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const HOLD_MS = durationParamMs("hold-ms", 1500);
const savedLiveView = readLiveViewState();

// Locking the phone is only safe where the native layer records through
// it (background location); the PWA is foreground-only.
const ACQUIRING_HINT = isTauri()
  ? "Make sure you're in an open, unobstructed area — it's safe to lock your phone."
  : "Make sure you're in an open, unobstructed area.";

const ARMED_HINT = isTauri()
  ? "Recording starts automatically when you launch — it's safe to lock your phone."
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
  const [ready, setReady] = useState(false);
  const [savedToastOpen, setSavedToastOpen] = useState(false);
  const [holding, setHolding] = useState(false);
  const [mapView, setMapView] = useState<MapViewKind>(
    savedLiveView.mapView ?? "street",
  );
  const [follow, setFollow] = useState(savedLiveView.follow ?? true);
  const [trackUp, setTrackUp] = useState(savedLiveView.trackUp ?? false);
  const [mapTopInset, setMapTopInset] = useState(0);
  const instrumentsRef = useRef<HTMLDivElement>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  const { track, latest, landingAt, error: gpsError } = snapshot;
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

  async function persistFlight(flown: Fix[]) {
    if (flown.length <= 1) return;
    const startedAt = flown[0].timestamp;
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
        },
        flown,
      );
    } catch (error) {
      if ((error as { name?: string }).name !== "conflict") throw error;
    }
    setSavedToastOpen(true);
  }

  // "ended" is a durable state: the finalized flight waits in the WAL.
  // Persist first, clear (stop) after — a crash in between just repeats
  // this on next launch, and the deterministic flight id makes it
  // idempotent.
  const collectEndedFlight = useEffectEvent(async () => {
    const snapshot = await engine.getSnapshot();
    if (snapshot.status !== "ended") return;
    await persistFlight(snapshot.track);
    // stop() clears the WAL and transitions to idle.
    await engine.stop();
  });

  useEffect(() => {
    getSetting("mapView").then((value) => {
      if (value === "street" || value === "satellite") setMapView(value);
    });
    // Kick the one-time WAL hydration; the subscription picks up the
    // resulting state change like any other.
    void engine.getSnapshot().then(() => setReady(true));
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
    await engine.stop();
  }

  async function finishFlight() {
    holdTimerRef.current = undefined;
    const flown = await engine.stop();
    setHolding(false);
    await persistFlight(flown);
  }

  function dismissLandingPrompt() {
    engine.dismissLanding();
  }

  function beginHold() {
    setHolding(true);
    holdTimerRef.current = setTimeout(finishFlight, HOLD_MS);
  }

  function cancelHold() {
    setHolding(false);
    clearTimeout(holdTimerRef.current);
    holdTimerRef.current = undefined;
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
  const toLaunchDistance = latest && first ? haversineMeters(latest, first) : 0;
  const toLaunchRelative =
    latest && first
      ? relativeBearing(latest.course, bearingBetween(latest, first))
      : 0;

  return (
    <IonPage>
      <IonContent fullscreen scrollY={false} className="fly-content">
        {status === "idle" && (
          <div className="fly-idle">
            <h1>Wingover</h1>
            <button className="start-button" onClick={armFlight}>
              Start Flight
            </button>
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
            <button className="cancel-button" onClick={cancelArmed}>
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
                label="Distance to launch"
                value={
                  latest && first
                    ? formatDistance(toLaunchDistance, units)
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
                label="Direction to launch"
                value={
                  latest && first
                    ? formatRelativeDegrees(toLaunchRelative)
                    : "—"
                }
                icon={
                  latest && first ? (
                    <span
                      className="launch-arrow"
                      style={{ rotate: `${toLaunchRelative}deg` }}
                      aria-hidden="true"
                    >
                      ↑
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
              onFollowChange={changeFollow}
            />
            <div className="flight-controls">
              <button
                className="map-button"
                aria-label="Follow aircraft"
                data-active={follow}
                onClick={() => changeFollow(true)}
              >
                <IonIcon icon={locateOutline} />
              </button>
              <button
                className="map-button"
                aria-label="Track up"
                data-active={trackUp}
                onClick={() => changeTrackUp(!trackUp)}
              >
                <IonIcon icon={compassOutline} />
              </button>
              <ViewToggle view={mapView} onChange={changeMapView} />
              <button
                className={
                  holding
                    ? "map-button stop-button holding"
                    : "map-button stop-button"
                }
                aria-label="Hold to stop"
                onPointerDown={beginHold}
                onPointerUp={cancelHold}
                onPointerLeave={cancelHold}
              >
                <IonIcon icon={stopIcon} />
              </button>
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
                  <button className="landing-stop" onClick={finishFlight}>
                    Stop &amp; save ({landingSecondsLeft})
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        <IonToast
          isOpen={savedToastOpen}
          message="Flight saved to logbook"
          duration={2000}
          position="top"
          onDidDismiss={() => setSavedToastOpen(false)}
        />
      </IonContent>
    </IonPage>
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
