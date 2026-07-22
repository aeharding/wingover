import {
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonTextarea,
  useIonActionSheet,
} from "@ionic/react";
import {
  chevronDownOutline,
  chevronUpOutline,
  contractOutline,
  ellipsisHorizontal,
  expandOutline,
} from "ionicons/icons";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { isTauri } from "../../engine/platform";
import { splitAvailable, trimAvailable } from "../../flight/clip";
import {
  formatAirtime,
  formatAltitude,
  formatDistance,
  formatSpeed,
} from "../../flight/format";
import { useAppearance } from "../appTheme";
import { afterNextFrame } from "../map/afterFrame";
import CompassButton from "../map/CompassButton";
import MapCanvas from "../map/MapCanvas";
import MapCluster from "../map/MapCluster";
import {
  ACCENT_CYAN,
  boundsOf,
  type Line,
  type LngLat,
  type MapView,
  type MarkerLayer,
  PLAN_LINE_COLOR,
} from "../map/types";
import useMapView from "../map/useMapView";
import ViewToggle from "../map/ViewToggle";
import { useReplayDrawer } from "../replay/useReplayDrawer";
import { useSettings } from "../settings/SettingsContext";
import { useFlightActions } from "../useFlightActions";
import { useFlightDoc } from "./useFlightDoc";
import { useFlightDrafts } from "./useFlightDrafts";

function endpointMarker(className: string, testId: string): HTMLElement {
  const element = document.createElement("div");
  element.className = className;
  element.setAttribute("data-testid", testId);
  return element;
}

/**
 * The desktop split's detail seat: one PERSISTENT component whose id swaps
 * as a prop. The MapCanvas mounts once and lives across selections — this
 * is the whole point of the split rebuild (a router-driven seat remounted
 * the map on every row click). The map fills the seat; the fields and
 * stats float over it in a collapsible card, so gestures land on the map.
 */
export default function FlightSeat({
  id,
  active = true,
  onDeleted,
}: {
  id: string;
  // False while the logbook section is URL-hidden: overlays portal outside
  // the hidden subtree and must close with their section.
  active?: boolean;
  onDeleted: () => void;
}) {
  const { units } = useSettings();
  const { exportFlight, confirmDeleteFlight } = useFlightActions();
  const { flight, setFlight, track } = useFlightDoc(id);
  const { drafts, setDraft, commit } = useFlightDrafts(
    flight,
    setFlight,
    track,
  );
  // The CONTROLLER hook, not a controlled <IonActionSheet isOpen>: each
  // present makes a fresh overlay. The controlled form desynced when the
  // sheet was reopened while the previous dismissal was still animating
  // (clip flows do exactly that): the late onDidDismiss stamped the open
  // flag false over the new request and the sheet went permanently mute.
  const [presentOptions, dismissOptions] = useIonActionSheet();
  const appearance = useAppearance();
  const [view, changeView] = useMapView();
  const [map, setMap] = useState<MapView | null>(null);
  const [mapFull, setMapFull] = useState(false);
  const [cardOpen, setCardOpen] = useState(true);
  const mapFullRef = useRef(false);
  const wasFullRef = useRef(false);
  const lineRef = useRef<Line | null>(null);
  const planLineRef = useRef<Line | null>(null);
  const markersRef = useRef<MarkerLayer | null>(null);
  const skipArrivalFrameRef = useRef(false);
  // The replay pane slides open under the seat map; closes with a
  // selection swap or when the section is URL-hidden.
  const replay = useReplayDrawer(map, track, flight, active);

  // The sheet portals outside the section's subtree; if the section goes
  // URL-hidden while it is up, it must fold with it.
  useEffect(() => {
    if (!active) void dismissOptions();
  }, [active, dismissOptions]);

  async function openOptions() {
    // The previous sheet may still be tearing down (the clip flows reopen
    // fast, and a busy frame stretches the dismiss animation); presenting
    // into its cleanup gets the new sheet silently destroyed with it.
    await dismissOptions();
    await presentOptions({
      buttons: [
        {
          text: "Export GPX",
          handler: () => {
            if (flight) exportFlight(flight);
          },
        },
        // The clip editors open in the pane under the seat map. Each
        // trim end is its own errand (usually it is one or the other).
        ...(trimAvailable(track)
          ? [
              {
                text: "Trim start",
                handler: () => replay.beginClip("trim-start"),
              },
              {
                text: "Trim end",
                handler: () => replay.beginClip("trim-end"),
              },
            ]
          : []),
        ...(splitAvailable(track)
          ? [
              {
                text: "Split flight",
                handler: () => replay.beginClip("split"),
              },
            ]
          : []),
        {
          text: "Delete flight",
          role: "destructive",
          handler: () => {
            if (flight) confirmDeleteFlight(flight, onDeleted);
          },
        },
        { text: "Cancel", role: "cancel" },
      ],
    });
  }

  // Full screen means NO chrome: the list pane, seat header and card hide
  // via the body class (see desktop.css), the tab rail goes with it, and
  // the PWA sheds browser chrome via the Fullscreen API. Reversed in
  // cleanup so navigating away can't strand anything.
  useEffect(() => {
    mapFullRef.current = mapFull;
    if (!mapFull) return;
    document.body.classList.add("flight-map-full");
    if (!isTauri()) {
      void document.documentElement
        .requestFullscreen?.()
        .then(() => {
          if (!mapFullRef.current && document.fullscreenElement) {
            void document.exitFullscreen().catch(() => {});
          }
        })
        .catch(() => {});
    }
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) setMapFull(false);
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      document.body.classList.remove("flight-map-full");
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      if (document.fullscreenElement) {
        void document.exitFullscreen().catch(() => {});
      }
    };
  }, [mapFull]);

  function handleReady(next: MapView | null) {
    if (!next) {
      planLineRef.current = null;
      lineRef.current = null;
      markersRef.current = null;
      setMap(null);
      return;
    }
    // A re-created map that inherited its camera (appearance flip) must
    // not be re-framed on arrival; one skip only — the next content
    // change (selection switch, clip rewrite) frames as always.
    skipArrivalFrameRef.current = next.restoredCamera === true;
    planLineRef.current = next.line({
      color: PLAN_LINE_COLOR,
      width: 3,
      opacity: 0.7,
      testId: "plan",
    });
    lineRef.current = next.line({
      color: ACCENT_CYAN,
      width: 4,
      testId: "track",
    });
    markersRef.current = next.markers();
    setMap(next);
  }

  // Draw-along replay owns the track line while active: the driver draws
  // the flown prefix, so the full line here goes blank. An Effect Event
  // shared by the main content effect AND the toggle effect below, so
  // toggling never re-frames the camera.
  const applyTrackVisibility = useEffectEvent(() => {
    if (!map || track.length === 0) return;
    lineRef.current?.set(
      replay.trackHidden
        ? []
        : track.map((fix): LngLat => [fix.longitude, fix.latitude]),
    );
  });

  useEffect(() => {
    applyTrackVisibility();
  }, [replay.trackHidden]);

  useEffect(() => {
    // Collapsing from full screen EASES back to the framed track instead of
    // jump-cutting (the jump read as a glitchy re-north; a bounds fit is
    // north-up by construction). Other refit causes stay instant.
    const collapsing = wasFullRef.current && !mapFull;
    wasFullRef.current = mapFull;
    if (!map) return;
    if (track.length === 0) {
      // Between selections: blank the previous flight's content.
      lineRef.current?.set([]);
      planLineRef.current?.set([]);
      markersRef.current?.set([]);
      return;
    }

    applyTrackVisibility();

    const launch = track[0];
    const landing = track[track.length - 1];
    const plannedRoute: LngLat[] = (flight?.plannedRoute ?? []).map(
      (coord): LngLat => [coord[0], coord[1]],
    );
    planLineRef.current?.set(
      plannedRoute.length > 0
        ? [[launch.longitude, launch.latitude], ...plannedRoute]
        : [],
    );
    markersRef.current?.set([
      {
        id: "launch",
        at: [launch.longitude, launch.latitude],
        el: endpointMarker("endpoint-marker launch", "launch-marker"),
        color: "#22a04a",
        label: "▶",
        glyphColor: "#ffffff",
      },
      {
        id: "landing",
        at: [landing.longitude, landing.latitude],
        el: endpointMarker("endpoint-marker landing", "landing-marker"),
        color: "#e0483a",
        label: "■",
        glyphColor: "#ffffff",
      },
    ]);

    const bounds = boundsOf([
      ...track.map((fix): LngLat => [fix.longitude, fix.latitude]),
      ...plannedRoute,
    ]);
    if (!bounds) return;
    if (skipArrivalFrameRef.current) {
      skipArrivalFrameRef.current = false;
      return;
    }
    // The fullscreen toggle resizes the map's container in this same
    // commit; fit only after the backend has adopted the new size (see
    // afterNextFrame) so the bounds math uses the real viewport.
    return afterNextFrame(() => {
      map.fitBounds(bounds, {
        // Right padding clears the OPEN card, always: collapsing must not
        // jump the camera around — it just reveals more of the map that
        // was under the card. Full screen hides the card entirely, so the
        // track expands to the whole viewport instead — including when
        // the arrow keys switch flights while full screen.
        padding: mapFull
          ? { top: 56, bottom: 56, left: 56, right: 56 }
          : { top: 56, bottom: 56, left: 56, right: 440 },
        animate: collapsing,
      });
    });
  }, [track, map, flight?.id, flight?.plannedRoute, mapFull]);

  const stats = flight?.stats;

  return (
    <div className="flight-seat">
      {/* No header bar: the map runs to the top of the seat; the title,
          date, and options live in the floating card. Embedded, the map is
          at the shell's right/top/bottom device edges (it keeps those) but
          the rail + pane cover its left (zeroed by .desktop-main); full
          screen the rail hides and body.flight-map-full restores the left
          edge for the whole seat (see desktop.css). When the scrub docks
          below, IT owns the bottom, so the map consumes it (the drawer is a
          sibling and keeps its own). */}
      <div
        className={`seat-map${replay.isOpen ? " consume-bottom" : ""}`}
        data-testid="seat-map"
      >
        <MapCanvas base={view} appearance={appearance} onReady={handleReady}>
          {/* The app-wide corner cluster (MapCluster), MIRRORED for the
              seat's bottom-LEFT anchor: the edge column (follow/play
              over the exit verb) hugs the left edge, the TR "compass
              slot" (north reset while the pane is closed, track-up while
              it is open) and globe sit inboard. Empty cells collapse —
              no state leaves buttons floating off the anchor — while TR
              passes null, never undefined, so the compass shares the top
              row instead of floating above it. */}
          <div className="map-overlay">
            <MapCluster
              tl={(replay.followButton ?? replay.playButton) || undefined}
              tr={
                replay.trackUpButton ??
                (map && !replay.isOpen ? <CompassButton map={map} /> : null)
              }
              bl={
                <button
                  className="map-button"
                  aria-label={mapFull ? "Shrink map" : "Expand map"}
                  data-testid="map-expand"
                  onClick={() => setMapFull(!mapFull)}
                >
                  <IonIcon icon={mapFull ? contractOutline : expandOutline} />
                </button>
              }
              br={
                map?.supportsSatellite ? (
                  <ViewToggle view={view} onChange={changeView} />
                ) : undefined
              }
            />
          </div>
        </MapCanvas>
        {flight && stats && (
          <div
            className={`seat-card${cardOpen ? "" : " collapsed"}`}
            data-testid="seat-card"
          >
            <div
              className="seat-card-header"
              onClick={(event) => {
                // The whole title row is the collapse toggle; the buttons
                // in it keep their own jobs.
                if ((event.target as HTMLElement).closest("button")) return;
                setCardOpen(!cardOpen);
              }}
            >
              {/* The WHEN as the header: the name is already the editable
                  field below and the highlighted row in the list. */}
              <div className="seat-card-title">
                {new Date(flight.startedAt).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </div>
              <button
                className="seat-card-collapse"
                aria-label="Options"
                data-testid="detail-options"
                onClick={openOptions}
              >
                <IonIcon icon={ellipsisHorizontal} />
              </button>
              <button
                className="seat-card-collapse"
                aria-label={cardOpen ? "Collapse details" : "Expand details"}
                onClick={() => setCardOpen(!cardOpen)}
              >
                <IonIcon
                  icon={cardOpen ? chevronUpOutline : chevronDownOutline}
                />
              </button>
            </div>
            {cardOpen && (
              <>
                <IonList>
                  <IonItem>
                    <IonInput
                      label="Name"
                      clearInput
                      autocapitalize="words"
                      placeholder="Add name"
                      value={drafts.name}
                      aria-label="Flight name"
                      onIonInput={(event) =>
                        setDraft("name", event.detail.value ?? "")
                      }
                      onIonBlur={commit}
                    />
                  </IonItem>
                  <IonItem>
                    <IonInput
                      label="Launch"
                      clearInput
                      autocapitalize="words"
                      placeholder="Add location"
                      value={drafts.launch}
                      aria-label="Launch location"
                      onIonInput={(event) =>
                        setDraft("launch", event.detail.value ?? "")
                      }
                      onIonBlur={commit}
                    />
                  </IonItem>
                  <IonItem>
                    <IonTextarea
                      label="Notes"
                      autocapitalize="sentences"
                      placeholder="Wing, motor, conditions…"
                      rows={1}
                      autoGrow
                      value={drafts.notes}
                      aria-label="Flight notes"
                      onIonInput={(event) =>
                        setDraft("notes", event.detail.value ?? "")
                      }
                      onIonBlur={commit}
                    />
                  </IonItem>
                </IonList>
                <IonList>
                  <Stat
                    label="Duration"
                    value={formatAirtime(stats.durationSeconds)}
                  />
                  <Stat
                    label="Distance"
                    value={formatDistance(stats.distanceMeters, units)}
                  />
                  <Stat
                    label="Max speed"
                    value={formatSpeed(stats.maxSpeed, units)}
                  />
                  <Stat
                    label="Avg speed"
                    value={formatSpeed(stats.averageSpeed, units)}
                  />
                  <Stat
                    label="Max altitude"
                    value={formatAltitude(stats.maxAltitude, units)}
                  />
                  <Stat
                    label="Max above launch"
                    lines="none"
                    value={formatAltitude(
                      stats.maxAltitude -
                        (stats.launchAltitude ?? stats.minAltitude),
                      units,
                    )}
                  />
                </IonList>
              </>
            )}
          </div>
        )}
      </div>
      {/* The replay pane, sliding open in flow under the seat map. */}
      {replay.drawer}
    </div>
  );
}

function Stat({
  label,
  value,
  lines,
}: {
  label: string;
  value: string;
  lines?: "none";
}) {
  return (
    <IonItem lines={lines}>
      <IonLabel>{label}</IonLabel>
      <IonNote slot="end" className="detail-stat-value">
        {value}
      </IonNote>
    </IonItem>
  );
}
