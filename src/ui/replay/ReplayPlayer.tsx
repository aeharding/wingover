import { compassOutline, locateOutline } from "ionicons/icons";
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import type { Fix, Waypoint } from "../../engine/types";
import { formatAltitude, formatClimb, formatSpeed } from "../../flight/format";
import type { Flight } from "../../storage/db";
import { getSetting, setSetting } from "../../storage/local";
import NativeIcon from "../components/NativeIcon";
import LiveTrackMap from "../flight/LiveTrackMap";
import Tile from "../flight/Tile";
import type { MapViewKind } from "../map/config";
import { readLiveViewState } from "../map/liveViewState";
import type { MapView } from "../map/types";
import ViewToggle from "../map/ViewToggle";
import { useSettings } from "../settings/SettingsContext";
import ReplayBar from "./ReplayBar";
import { useReplayFeed } from "./useReplayFeed";

import "./ReplayPlayer.css";

interface ReplayPlayerProps {
  flight: Flight;
  // At least 2 fixes (the host gates availability). Remount (key) per flight.
  track: Fix[];
  onClose: () => void;
  // Host-specific transport extras (the desktop card's expand button).
  actions?: ReactNode;
}

/**
 * A faithful re-run of what the pilot saw in flight — the live surface
 * (light basemap, follow + track-up camera, instrument tiles, growing cyan
 * track) driven by the replay clock instead of GPS — plus the transport
 * bar. Self-contained: it owns its own LiveTrackMap and never touches the
 * pilot's live-view prefs (persistView={false}).
 */
export default function ReplayPlayer({
  flight,
  track,
  onClose,
  actions,
}: ReplayPlayerProps) {
  const { units } = useSettings();
  const feed = useReplayFeed(track);
  const [view, setView] = useState<MapViewKind>("street");
  // The in-flight camera modes, session-local. Follow defaults ON (the
  // pilot's view); track-up starts from their persisted in-flight habit.
  const [camera, setCamera] = useState(() => ({
    follow: true,
    trackUp: readLiveViewState().trackUp ?? false,
  }));
  const [map, setMap] = useState<MapView | null>(null);
  const [topInset, setTopInset] = useState(0);
  const instrumentsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getSetting("mapView").then((value) => {
      if (value === "street" || value === "satellite") setView(value);
    });
  }, []);

  useLayoutEffect(() => {
    const measure = () =>
      setTopInset(instrumentsRef.current?.getBoundingClientRect().height ?? 0);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  function changeView(value: MapViewKind) {
    setView(value);
    setSetting("mapView", value);
  }

  // Same coupling as in flight: unsnapping drops track-up with it, so
  // resuming is two deliberate presses.
  function changeFollow(value: boolean) {
    setCamera((prior) =>
      value ? { ...prior, follow: true } : { follow: false, trackUp: false },
    );
  }

  // The planned route as flight-style waypoints, so the grey plan line and
  // numbered pins render exactly as the pilot saw them. (Which pins were
  // "reached" at each moment isn't recorded; all of them stay visible.)
  const plannedWaypoints: Waypoint[] = (flight.plannedRoute ?? []).map(
    ([longitude, latitude], index) => ({
      id: `plan-${index}`,
      latitude,
      longitude,
      radiusM: 0,
    }),
  );

  const first = track[0];
  const latest = feed.latest;

  return (
    <div className="replay-player">
      <div className="replay-map">
        <div className="instruments" ref={instrumentsRef}>
          <Tile
            label="Above launch"
            value={formatAltitude(latest.altitude - first.altitude, units)}
            accent="cyan"
            testId="replay-agl"
          />
          <Tile
            label="Altitude MSL"
            value={formatAltitude(latest.altitude, units)}
            testId="replay-msl"
          />
          <Tile
            label="Ground speed"
            value={formatSpeed(latest.speed, units)}
            accent="green"
            testId="replay-ground-speed"
          />
          <Tile
            label="Climb rate"
            value={formatClimb(latest.climbRate, units)}
            accent="yellow"
            testId="replay-climb"
          />
        </div>
        <LiveTrackMap
          track={feed.track}
          latest={latest}
          view={view}
          follow={camera.follow}
          trackUp={camera.trackUp}
          topInset={topInset}
          plannedWaypoints={plannedWaypoints}
          navWaypoints={plannedWaypoints}
          persistView={false}
          onFollowChange={changeFollow}
          onMapReady={setMap}
        />
        <div className="replay-controls">
          <button
            className="map-button"
            aria-label={camera.follow ? "Track up" : "Align north"}
            data-active={camera.follow && camera.trackUp}
            onClick={() => {
              if (camera.follow) {
                setCamera((prior) => ({ ...prior, trackUp: !prior.trackUp }));
                return;
              }
              map?.moveTo({ bearing: 0 }, { animate: false });
            }}
          >
            <NativeIcon icon={compassOutline} />
          </button>
          <button
            className="map-button"
            aria-label="Follow aircraft"
            data-active={camera.follow}
            onClick={() => changeFollow(!camera.follow)}
          >
            <NativeIcon icon={locateOutline} />
          </button>
          {map?.supportsSatellite && (
            <ViewToggle view={view} onChange={changeView} />
          )}
        </div>
      </div>
      <ReplayBar feed={feed} track={track} onClose={onClose} actions={actions} />
    </div>
  );
}
