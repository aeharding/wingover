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
import type { Feature } from "geojson";
import {
  chevronDownOutline,
  chevronUpOutline,
  ellipsisHorizontal,
} from "ionicons/icons";
import type { Map as MapLibreMap } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router";

import type { Fix } from "../engine/types";
import {
  formatAltitude,
  formatDistance,
  formatDuration,
  formatSpeed,
} from "../flight/format";
import { useFlightActions } from "../flight/useFlightActions";
import MapView, { type MapLibreModule } from "../map/MapView";
import { labelInsertionPoint } from "../map/layers";
import ViewToggle from "../map/ViewToggle";
import type { MapViewKind } from "../map/config";
import { useSettings } from "../settings/SettingsContext";
import {
  getFlight,
  getSetting,
  getTrack,
  setSetting,
  updateFlight,
  type Flight,
} from "../storage/db";
import "./FlightDetailPage.css";

function toLineData(track: Fix[]): Feature {
  return {
    type: "Feature",
    properties: {},
    geometry: {
      type: "LineString",
      coordinates: track.map((fix) => [fix.longitude, fix.latitude]),
    },
  };
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
  const [mapReady, setMapReady] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [draftName, setDraftName] = useState("");
  const [draftNotes, setDraftNotes] = useState("");
  const mapRef = useRef<MapLibreMap | null>(null);
  const libRef = useRef<MapLibreModule | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<Fix[]>([]);
  trackRef.current = track;

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

  function ensureTrackLayer(map: MapLibreMap) {
    if (!map.isStyleLoaded()) return;
    if (map.getSource("track") || trackRef.current.length === 0) return;
    map.addSource("track", {
      type: "geojson",
      data: toLineData(trackRef.current),
    });
    const firstSymbol = labelInsertionPoint(map);
    map.addLayer(
      {
        id: "track",
        type: "line",
        source: "track",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#4cc2ff", "line-width": 4 },
      },
      firstSymbol,
    );
    map.getContainer().setAttribute("data-track-layer", "true");
  }

  function handleReady(map: MapLibreMap, lib: MapLibreModule) {
    mapRef.current = map;
    libRef.current = lib;
    map.on("styledata", () => ensureTrackLayer(map));
    map.on("idle", () => ensureTrackLayer(map));
    setMapReady(true);
  }

  useEffect(() => {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!map || !lib || !mapReady || track.length === 0) return;

    ensureTrackLayer(map);

    const launch = track[0];
    const landing = track[track.length - 1];
    const markers = [
      {
        fix: launch,
        className: "endpoint-marker launch",
        testId: "launch-marker",
      },
      {
        fix: landing,
        className: "endpoint-marker landing",
        testId: "landing-marker",
      },
    ].map(({ fix, className, testId }) => {
      const element = document.createElement("div");
      element.className = className;
      element.setAttribute("data-testid", testId);
      return new lib.Marker({ element })
        .setLngLat([fix.longitude, fix.latitude])
        .addTo(map);
    });

    const bounds = new lib.LngLatBounds();
    for (const fix of track) bounds.extend([fix.longitude, fix.latitude]);
    const overlayHeight =
      overlayRef.current?.getBoundingClientRect().height ?? 0;
    map.fitBounds(bounds, {
      padding: {
        top: (overlayHeight || 220) + 28,
        bottom: 60,
        left: 50,
        right: 50,
      },
      animate: false,
    });

    return () => {
      for (const marker of markers) marker.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track, mapReady, flight?.id]);

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
      <IonContent>
        <div className="flight-detail-map">
          <MapView view={view} onReady={handleReady} />
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
