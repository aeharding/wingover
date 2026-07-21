import {
  IonActionSheet,
  IonButton,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonTextarea,
} from "@ionic/react";
import {
  chevronDownOutline,
  chevronUpOutline,
  contractOutline,
  ellipsisHorizontal,
  expandOutline,
} from "ionicons/icons";
import { useEffect, useRef, useState } from "react";

import { isTauri } from "../../engine/platform";
import {
  flightTitle,
  formatAirtime,
  formatAltitude,
  formatDistance,
  formatSpeed,
} from "../../flight/format";
import { getSetting, setSetting } from "../../storage/local";
import CompassButton from "../map/CompassButton";
import type { MapViewKind } from "../map/config";
import MapCanvas from "../map/MapCanvas";
import {
  ACCENT_CYAN,
  boundsOf,
  type Line,
  type LngLat,
  type MapView,
  type MarkerLayer,
  PLAN_LINE_COLOR,
} from "../map/types";
import ViewToggle from "../map/ViewToggle";
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
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [view, setView] = useState<MapViewKind>("street");
  const [map, setMap] = useState<MapView | null>(null);
  const [mapFull, setMapFull] = useState(false);
  const [cardOpen, setCardOpen] = useState(true);
  const mapFullRef = useRef(false);
  const lineRef = useRef<Line | null>(null);
  const planLineRef = useRef<Line | null>(null);
  const markersRef = useRef<MarkerLayer | null>(null);

  useEffect(() => {
    getSetting("mapView").then((value) => {
      if (value === "street" || value === "satellite") setView(value);
    });
  }, [id]);

  function changeView(value: MapViewKind) {
    setView(value);
    setSetting("mapView", value);
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

  useEffect(() => {
    if (!map) return;
    if (track.length === 0) {
      // Between selections: blank the previous flight's content.
      lineRef.current?.set([]);
      planLineRef.current?.set([]);
      markersRef.current?.set([]);
      return;
    }

    lineRef.current?.set(
      track.map((fix): LngLat => [fix.longitude, fix.latitude]),
    );

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
    if (bounds) {
      map.fitBounds(bounds, {
        // Right padding clears the OPEN card, always: collapsing must not
        // jump the camera around — it just reveals more of the map that
        // was under the card. Full screen hides the card entirely, so the
        // track expands to the whole viewport instead — including when
        // the arrow keys switch flights while full screen.
        padding: mapFull
          ? { top: 56, bottom: 56, left: 56, right: 56 }
          : { top: 56, bottom: 56, left: 56, right: 440 },
      });
    }
  }, [track, map, flight?.id, flight?.plannedRoute, mapFull]);

  const stats = flight?.stats;

  return (
    <div className="flight-seat">
      <div className="seat-header">
        <div className="seat-title">
          {flight
            ? new Date(flight.startedAt).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                year: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })
            : ""}
        </div>
        <IonButton
          fill="clear"
          aria-label="Options"
          data-testid="detail-options"
          onClick={() => setOptionsOpen(true)}
        >
          <IonIcon slot="icon-only" icon={ellipsisHorizontal} />
        </IonButton>
      </div>
      <div className="seat-map">
        {/* Edge-to-edge only when expanded to full screen; embedded in the
            desktop split it sits above other UI, so no inset. */}
        <MapCanvas base={view} onReady={handleReady} edgeToEdge={mapFull} />
        <div className="map-overlay">
          {map && <CompassButton map={map} />}
          <button
            className="map-button"
            aria-label={mapFull ? "Shrink map" : "Expand map"}
            data-testid="map-expand"
            onClick={() => setMapFull(!mapFull)}
          >
            <IonIcon icon={mapFull ? contractOutline : expandOutline} />
          </button>
          {map?.supportsSatellite && (
            <ViewToggle view={view} onChange={changeView} />
          )}
        </div>
        {flight && stats && (
          <div className={`seat-card${cardOpen ? "" : " collapsed"}`}>
            <div className="seat-card-header">
              <div className="seat-card-title">{flightTitle(flight)}</div>
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
      <IonActionSheet
        isOpen={optionsOpen && active}
        onDidDismiss={() => setOptionsOpen(false)}
        buttons={[
          {
            text: "Export GPX",
            handler: () => {
              if (flight) exportFlight(flight);
            },
          },
          {
            text: "Delete flight",
            role: "destructive",
            handler: () => {
              if (flight) confirmDeleteFlight(flight, onDeleted);
            },
          },
          { text: "Cancel", role: "cancel" },
        ]}
      />
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
