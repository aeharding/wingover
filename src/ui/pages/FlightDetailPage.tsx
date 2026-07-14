import {
  IonActionSheet,
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonPage,
  IonTitle,
  IonToolbar,
  useIonRouter,
  useIonViewWillEnter,
} from "@ionic/react";
import {
  chevronDownOutline,
  chevronUpOutline,
  ellipsisHorizontal,
} from "ionicons/icons";
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router";

import type { Fix } from "../../engine/types";
import {
  formatAltitude,
  formatDistance,
  formatDuration,
  formatSpeed,
} from "../../flight/format";
import {
  type Flight,
  getFlight,
  getSetting,
  getTrack,
  setSetting,
  updateFlight,
} from "../../storage/db";
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

import "./FlightDetailPage.css";

function endpointMarker(className: string, testId: string): HTMLElement {
  const element = document.createElement("div");
  element.className = className;
  element.setAttribute("data-testid", testId);
  return element;
}

export default function FlightDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useIonRouter();
  const { units } = useSettings();
  const { exportFlight, confirmDeleteFlight } = useFlightActions();
  const [flight, setFlight] = useState<Flight | null>(null);
  const [track, setTrack] = useState<Fix[]>([]);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [view, setView] = useState<MapViewKind>("street");
  const [map, setMap] = useState<MapView | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [draftName, setDraftName] = useState("");
  const [draftNotes, setDraftNotes] = useState("");
  const lineRef = useRef<Line | null>(null);
  const planLineRef = useRef<Line | null>(null);
  const markersRef = useRef<MarkerLayer | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  useIonViewWillEnter(() => {
    getFlight(id).then((found) => {
      setFlight(found);
      setDraftName(found?.name ?? "");
      setDraftNotes(found?.notes ?? "");
    });
    getTrack(id).then(setTrack);
    getSetting("mapView").then((value) => {
      if (value === "street" || value === "satellite") setView(value);
    });
  }, [id]);

  function changeView(value: MapViewKind) {
    setView(value);
    setSetting("mapView", value);
  }

  function commitDetails() {
    if (!flight) return;
    const name = draftName.trim() || flight.name;
    const notes = draftNotes;
    if (name === flight.name && notes === flight.notes) return;
    setDraftName(name);
    updateFlight(flight.id, { name, notes });
    setFlight({ ...flight, name, notes });
  }

  function handleReady(next: MapView) {
    // Grey planned-route reference, created first so it sits UNDER the cyan
    // flown track (later lines draw on top). No markers — just the line.
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
    if (!map || track.length === 0) return;

    lineRef.current?.set(track.map((fix): LngLat => [fix.longitude, fix.latitude]));

    const launch = track[0];
    const landing = track[track.length - 1];

    // The grey plan line: launch through every planned pin (no markers). Empty
    // for flights recorded without a plan (and imports) — clears the line.
    // Copy each stored (readonly) coord into a fresh map LngLat tuple.
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
        // Launch green (darker than the bright plan green so the white glyph
        // reads) / landing red, for native (MapKit) pins. The glyph (MapKit's
        // glyphText) is a white start ▶ / stop ■ instead of the default dot.
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

    // Fit the flown track and the planned pins together, so a plan that
    // overshoots the track (unreached waypoints) still frames fully.
    const bounds = boundsOf([
      ...track.map((fix): LngLat => [fix.longitude, fix.latitude]),
      ...plannedRoute,
    ]);
    const overlayHeight =
      overlayRef.current?.getBoundingClientRect().height ?? 0;
    if (bounds) {
      map.fitBounds(bounds, {
        padding: {
          top: (overlayHeight || 220) + 28,
          bottom: 60,
          left: 50,
          right: 50,
        },
      });
    }
  }, [track, map, flight?.id, flight?.plannedRoute]);

  const stats = flight?.stats;

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <IonBackButton defaultHref="/logbook" />
          </IonButtons>
          <IonTitle>{flight?.name ?? "Flight"}</IonTitle>
          <IonButtons slot="end">
            <IonButton
              aria-label="Options"
              data-testid="detail-options"
              onClick={() => setOptionsOpen(true)}
            >
              <IonIcon slot="icon-only" icon={ellipsisHorizontal} />
            </IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent scrollY={false}>
        <div className="flight-detail-map">
          <MapCanvas base={view} onReady={handleReady} />
          {flight && stats && (
            <div className="detail-overlay" ref={overlayRef}>
              <div className="detail-overlay-header">
                {expanded ? (
                  <input
                    className="detail-title"
                    value={draftName}
                    aria-label="Flight name"
                    onChange={(event) => setDraftName(event.target.value)}
                    onBlur={commitDetails}
                  />
                ) : (
                  <div className="detail-title-static">{flight.name}</div>
                )}
                <button
                  className="collapse-button"
                  aria-label={expanded ? "Collapse details" : "Expand details"}
                  onClick={() => setExpanded(!expanded)}
                >
                  <IonIcon
                    icon={expanded ? chevronUpOutline : chevronDownOutline}
                  />
                </button>
              </div>
              {expanded && (
                <>
                  <textarea
                    className="detail-notes"
                    placeholder="Wing, motor, conditions…"
                    rows={2}
                    value={draftNotes}
                    aria-label="Flight notes"
                    onChange={(event) => setDraftNotes(event.target.value)}
                    onBlur={commitDetails}
                  />
                  <div className="detail-stats">
                    <Stat
                      label="Duration"
                      value={formatDuration(stats.durationSeconds)}
                    />
                    <Stat
                      label="Distance"
                      value={formatDistance(stats.distanceMeters, units)}
                    />
                    <Stat
                      label="Max above launch"
                      value={formatAltitude(
                        stats.maxAltitude -
                          (stats.launchAltitude ?? stats.minAltitude),
                        units,
                      )}
                    />
                    <Stat
                      label="Max altitude"
                      value={formatAltitude(stats.maxAltitude, units)}
                    />
                    <Stat
                      label="Max speed"
                      value={formatSpeed(stats.maxSpeed, units)}
                    />
                    <Stat
                      label="Avg speed"
                      value={formatSpeed(stats.averageSpeed, units)}
                    />
                  </div>
                </>
              )}
            </div>
          )}
          <div className="map-overlay">
            <ViewToggle view={view} onChange={changeView} />
          </div>
        </div>
        <IonActionSheet
          isOpen={optionsOpen}
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
                if (flight)
                  confirmDeleteFlight(flight, () =>
                    router.push("/logbook", "back"),
                  );
              },
            },
            { text: "Cancel", role: "cancel" },
          ]}
        />
      </IonContent>
    </IonPage>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-stat">
      <div className="detail-stat-label">{label}</div>
      <div className="detail-stat-value">{value}</div>
    </div>
  );
}
