import {
  closeOutline,
  compassOutline,
  locateOutline,
  locationOutline,
  stop as stopIcon,
} from "ionicons/icons";

import type { Waypoint } from "../../engine/types";
import NativeIcon from "../shared/components/NativeIcon";
import { cx } from "../shared/cx";
import type { MapViewKind } from "../shared/map/config";
import MapCluster from "../shared/map/MapCluster";
import type { MapView } from "../shared/map/types";
import ViewToggle from "../shared/map/ViewToggle";

import mapCss from "../shared/map/map.module.css";
import styles from "./FlightSurface.module.css";

/**
 * The in-flight map controls: the app-wide 2x2 corner cluster plus the one
 * contextual button above it.
 */
export default function MapControls({
  mapView,
  follow,
  trackUp,
  liveMap,
  selectedWaypoint,
  onChangeMapView,
  onChangeFollow,
  onChangeTrackUp,
  onClearWaypoint,
  onStop,
}: {
  mapView: MapViewKind;
  follow: boolean;
  trackUp: boolean;
  liveMap: MapView | null;
  selectedWaypoint: Waypoint | null;
  onChangeMapView: (view: MapViewKind) => void;
  onChangeFollow: (follow: boolean) => void;
  onChangeTrackUp: (trackUp: boolean) => void;
  onClearWaypoint: (id: string) => void;
  onStop: () => void;
}) {
  function pressCompass() {
    if (follow) {
      onChangeTrackUp(!trackUp);
      return;
    }
    // Unsnapped, the compass is a north reset: bearing
    // zero, immediately, mode untouched. No animation,
    // ever, in flight. Always present — a control that
    // comes and goes is worse than one that occasionally
    // has nothing to do.
    liveMap?.moveTo({ bearing: 0 }, { animate: false });
  }

  return (
    <div className={styles.controls} data-testid="map-controls">
      {/* Contextual: floats ABOVE the fixed control grid (which is
            bottom-anchored) so appearing/disappearing never nudges the
            four regular controls out of their fixed positions. */}
      {selectedWaypoint && (
        <button
          className={mapCss.button}
          aria-label="Clear selected waypoint"
          data-testid="remove-waypoint"
          onClick={() => onClearWaypoint(selectedWaypoint.id)}
        >
          {/* A location pin with a small trash badge: "delete this
                selected checkpoint". */}
          <span className={styles.skipIcon} aria-hidden="true">
            <span className={styles.skipIconPin}>
              <NativeIcon icon={locationOutline} />
            </span>
            <NativeIcon className={styles.skipIconBadge} icon={closeOutline} />
          </span>
        </button>
      )}
      {/* The app-wide corner cluster (MapCluster): this page IS
          the reference layout the replay hosts mirror. Explicit
          cells also pin stop to BR on builds without satellite
          (flow order used to slide it into globe's cell). */}
      <MapCluster
        tl={
          <button
            className={mapCss.button}
            aria-label={follow ? "Track up" : "Align north"}
            // The mode light shows only while the mode is in
            // effect (unsnapping also clears the pref; the gate
            // guards any future unsnap path that forgets to).
            data-active={follow && trackUp}
            onClick={pressCompass}
          >
            <NativeIcon icon={compassOutline} />
          </button>
        }
        tr={
          <button
            className={mapCss.button}
            aria-label="Follow aircraft"
            data-active={follow}
            // A toggle: pressing while snapped unsnaps (and takes
            // track-up down with it, via onChangeFollow).
            onClick={() => onChangeFollow(!follow)}
          >
            <NativeIcon icon={locateOutline} />
          </button>
        }
        bl={
          liveMap?.supportsSatellite ? (
            <ViewToggle view={mapView} onChange={onChangeMapView} />
          ) : undefined
        }
        br={
          <button
            className={cx(mapCss.button, styles.stop)}
            aria-label="Stop flight"
            onClick={onStop}
          >
            <NativeIcon icon={stopIcon} />
          </button>
        }
      />
    </div>
  );
}
