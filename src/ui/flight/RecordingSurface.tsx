import { useState } from "react";

import type { EngineSnapshot } from "../../engine/types";
import type { Units } from "../../flight/format";
import { LANDING_GRACE_MS } from "../../flight/landing";
import type { MapViewKind } from "../map/config";
import type { MapView } from "../map/types";
import { ConfirmSurface } from "./BigConfirm";
import InstrumentsStrip from "./InstrumentsStrip";
import LiveTrackMap from "./LiveTrackMap";
import MapControls from "./MapControls";
import { useInstrumentInsets } from "./useInstrumentInsets";
import type { LiveView } from "./useLiveViewPrefs";
import { useWaypointUi } from "./useWaypointUi";

import styles from "./FlightSurface.module.css";

/**
 * The live-flight screen: instruments over the map, the corner controls,
 * and the two in-flight dialogs. Everything here is scoped to the flight
 * — the selected/proposed waypoint, the measured instrument insets, the
 * map handle — so none of it outlives the recording.
 */
export default function RecordingSurface({
  snapshot,
  units,
  liveView,
  onStop,
  onEndNow,
  onDismissLanding,
}: {
  snapshot: EngineSnapshot;
  units: Units;
  liveView: LiveView;
  onStop: () => void;
  onEndNow: () => void;
  onDismissLanding: () => void;
}) {
  const { track, latest, landingAt, nextWaypoint } = snapshot;
  const [liveMap, setLiveMap] = useState<MapView | null>(null);
  const { ref: instrumentsRef, insets } = useInstrumentInsets();
  const waypoints = useWaypointUi(snapshot.activeWaypoints, nextWaypoint?.id);
  const { mapView, follow, trackUp, update } = liveView;

  const first = track[0];
  const pending = waypoints.pending;
  const showLandingPrompt = snapshot.status === "landed" && landingAt !== null;

  function changeMapView(value: MapViewKind) {
    update({ mapView: value });
  }

  function changeFollow(value: boolean) {
    // Unsnapping drops track-up WITH it: resuming is two deliberate
    // presses (snap, then compass), never one button silently re-enabling
    // a second mode.
    if (!value) {
      update({ follow: false, trackUp: false });
      return;
    }
    update({ follow: true });
  }

  function changeTrackUp(value: boolean) {
    update({ trackUp: value });
  }

  function landingCountdown() {
    if (landingAt === null || !latest) return 0;
    const remaining = LANDING_GRACE_MS - (latest.timestamp - landingAt);
    return Math.max(0, Math.ceil(remaining / 1000));
  }

  function landingAction() {
    if (!snapshot.autoEnd) return "Stop";
    return `Stop (${landingCountdown()})`;
  }

  return (
    <div className={styles.recording} data-testid="recording">
      <InstrumentsStrip
        ref={instrumentsRef}
        latest={latest}
        first={first}
        nextWaypoint={nextWaypoint}
        units={units}
      />
      <LiveTrackMap
        className={styles.liveMap}
        track={track}
        latest={latest}
        view={mapView}
        follow={follow}
        trackUp={trackUp}
        topInset={insets.top}
        leftInset={insets.left}
        plannedWaypoints={snapshot.waypoints}
        navWaypoints={snapshot.activeWaypoints}
        onMapReady={setLiveMap}
        onAddWaypoint={waypoints.propose}
        onSelectWaypoint={waypoints.select}
        onFollowChange={changeFollow}
      />
      <MapControls
        mapView={mapView}
        follow={follow}
        trackUp={trackUp}
        liveMap={liveMap}
        selectedWaypoint={waypoints.selected}
        onChangeMapView={changeMapView}
        onChangeFollow={changeFollow}
        onChangeTrackUp={changeTrackUp}
        onClearWaypoint={waypoints.clearSelected}
        onStop={onStop}
      />
      {pending && (
        /* Same surface as the stop confirm and landing prompt: one
           dialog language in flight. Scrim = Cancel. */
        <ConfirmSurface
          scrimTestId="waypoint-confirm"
          title="Add a checkpoint here?"
          cancelLabel="Cancel"
          action="Add"
          onCancel={waypoints.dismissPending}
          onAction={() => waypoints.addPending(pending)}
        />
      )}
      {showLandingPrompt && (
        /* The end-flight confirm's exact surface (ConfirmSurface):
             one dialog language in flight. The scrim is the safe
             answer, like Cancel there. */
        <ConfirmSurface
          scrimTestId="landing-prompt"
          title="Landing detected"
          cancelLabel="Still flying"
          action={landingAction()}
          onCancel={onDismissLanding}
          onAction={onEndNow}
        />
      )}
    </div>
  );
}
