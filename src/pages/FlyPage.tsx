import { IonContent, IonIcon, IonPage, IonToast } from "@ionic/react";
import {
  compassOutline,
  locateOutline,
  stop as stopIcon,
} from "ionicons/icons";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import Tile from "../components/Tile";
import { engine } from "../engine";
import type { EngineStatus, Fix } from "../engine/types";
import LiveTrackMap from "../map/LiveTrackMap";
import ViewToggle from "../map/ViewToggle";
import type { MapViewKind } from "../map/config";
import { readLiveViewState, writeLiveViewState } from "../map/liveViewState";
import {
  formatAltitude,
  formatClimb,
  formatCourse,
  formatDistance,
  formatDuration,
  formatRelativeDegrees,
  formatSpeed,
} from "../flight/format";
import { bearingBetween, relativeBearing } from "../flight/nav";
import { computeStats, haversineMeters } from "../flight/stats";
import { useSettings } from "../settings/SettingsContext";
import { getSetting, saveFlight, setSetting } from "../storage/db";
import "./FlyPage.css";

const initialSearch = location.search;

function holdDurationMs(): number {
  const raw = new URLSearchParams(initialSearch).get("hold-ms");
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1500;
}

const HOLD_MS = holdDurationMs();

export default function FlyPage() {
  const { units } = useSettings();
  const [status, setStatus] = useState<EngineStatus | "loading">("loading");
  const [latest, setLatest] = useState<Fix | null>(null);
  const [, setFixCount] = useState(0);
  const [savedToastOpen, setSavedToastOpen] = useState(false);
  const [holding, setHolding] = useState(false);
  const savedLiveView = useRef(readLiveViewState()).current;
  const [mapView, setMapView] = useState<MapViewKind>(
    savedLiveView.mapView ?? "street",
  );
  const [follow, setFollow] = useState(savedLiveView.follow ?? true);
  const [trackUp, setTrackUp] = useState(savedLiveView.trackUp ?? false);
  const [mapTopInset, setMapTopInset] = useState(0);
  const instrumentsRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<EngineStatus | "loading">("loading");
  const trackRef = useRef<Fix[]>([]);
  const distanceRef = useRef(0);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  function applyStatus(value: EngineStatus | "loading") {
    statusRef.current = value;
    setStatus(value);
  }

  async function syncFromEngine() {
    const snapshot = await engine.getSnapshot();
    trackRef.current = snapshot.track;
    distanceRef.current = computeStats(snapshot.track).distanceMeters;
    setLatest(snapshot.track[snapshot.track.length - 1] ?? null);
    setFixCount(snapshot.track.length);
    applyStatus(snapshot.status);
  }

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

  useEffect(() => {
    getSetting("mapView").then((value) => {
      if (value === "street" || value === "satellite") setMapView(value);
    });
    syncFromEngine();

    const unsubscribeFix = engine.onFix((fix) => {
      setLatest(fix);
      if (statusRef.current !== "recording") return;
      const previous = trackRef.current[trackRef.current.length - 1];
      if (previous && fix.timestamp <= previous.timestamp) return;
      if (previous) distanceRef.current += haversineMeters(previous, fix);
      trackRef.current.push(fix);
      setFixCount(trackRef.current.length);
    });

    const unsubscribeStatus = engine.onStatus(() => {
      syncFromEngine();
    });

    return () => {
      unsubscribeFix();
      unsubscribeStatus();
    };
  }, []);

  useLayoutEffect(() => {
    if (status !== "recording") return;
    const measure = () =>
      setMapTopInset(
        instrumentsRef.current?.getBoundingClientRect().height ?? 0,
      );
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [status]);

  async function armFlight() {
    trackRef.current = [];
    distanceRef.current = 0;
    setLatest(null);
    setFixCount(0);
    changeFollow(true);
    changeTrackUp(false);
    await engine.start();
    applyStatus("acquiring");
  }

  async function cancelArmed() {
    await engine.stop();
    applyStatus("idle");
    setLatest(null);
  }

  async function finishFlight() {
    holdTimerRef.current = undefined;
    const track = await engine.stop();
    setHolding(false);
    applyStatus("idle");
    setLatest(null);
    if (track.length > 1) {
      const startedAt = track[0].timestamp;
      await saveFlight(
        {
          id: crypto.randomUUID(),
          name: `Flight ${new Date(startedAt).toLocaleString()}`,
          notes: "",
          startedAt,
          stats: computeStats(track),
          updatedAt: Date.now(),
        },
        track,
      );
      setSavedToastOpen(true);
    }
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

  const first = trackRef.current[0];
  const durationSeconds =
    latest && first && status === "recording"
      ? (latest.timestamp - first.timestamp) / 1000
      : 0;
  const toLaunchDistance = latest && first ? haversineMeters(latest, first) : 0;
  const toLaunchRelative =
    latest && first
      ? relativeBearing(latest.course, bearingBetween(latest, first))
      : 0;

  return (
    <IonPage>
      <IonContent fullscreen className="fly-content">
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
              <p>
                {status === "acquiring"
                  ? "Hang tight while accuracy improves."
                  : "Recording starts automatically when you launch."}
              </p>
            </div>
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
        {status === "recording" && (
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
              track={trackRef.current}
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
