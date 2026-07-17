import {
  IonIcon,
  IonButton,
  IonBackButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonPage,
  IonTitle,
  IonToolbar,
  useIonViewWillEnter,
} from "@ionic/react";
import { chevronBackOutline } from "ionicons/icons";
import { useHistory } from "react-router-dom";
import type { Feature } from "geojson";
import { useEffect, useRef, useState } from "react";

import { getTrack, listFlights } from "../../storage/db";
import { getSetting, setSetting } from "../../storage/local";
import type { MapViewKind } from "../map/config";
import MapCanvas from "../map/MapCanvas";
import { boundsOf, type Line, type LngLat, type MapView } from "../map/types";
import ViewToggle from "../map/ViewToggle";
import { useIsDesktop } from "../useIsDesktop";

import "./AllFlightsMapPage.css";

const OLDEST_HUE = 290;
const NEWEST_HUE = 175;

function rampColor(t: number): string {
  const hue = OLDEST_HUE + (NEWEST_HUE - OLDEST_HUE) * t;
  const lightness = 48 + 14 * t;
  return `hsl(${Math.round(hue)}, 85%, ${Math.round(lightness)}%)`;
}

export default function AllFlightsMapPage() {
  const history = useHistory();
  const isDesktop = useIsDesktop();
  const [view, setView] = useState<MapViewKind>("street");
  const [features, setFeatures] = useState<Feature[]>([]);
  const [map, setMap] = useState<MapView | null>(null);
  const lineRef = useRef<Line | null>(null);

  function load() {
    getSetting("mapView").then((value) => {
      if (value === "street" || value === "satellite") setView(value);
    });
    (async () => {
      const flights = (await listFlights()).sort(
        (a, b) => a.startedAt - b.startedAt,
      );
      const built: Feature[] = [];
      for (let i = 0; i < flights.length; i++) {
        const fixes = await getTrack(flights[i].id);
        if (fixes.length < 2) continue;
        const t = flights.length > 1 ? i / (flights.length - 1) : 1;
        built.push({
          type: "Feature",
          properties: { color: rampColor(t) },
          geometry: {
            type: "LineString",
            coordinates: fixes.map((fix) => [fix.longitude, fix.latitude]),
          },
        });
      }
      setFeatures(built);
    })();
  }

  // Will-enter for the phone shell; a mount effect for the desktop shell
  // (no Ionic lifecycle there).
  useIonViewWillEnter(() => {
    load();
  });

  useEffect(() => {
    load();
  }, []);

  function changeView(value: MapViewKind) {
    setView(value);
    setSetting("mapView", value);
  }

  function handleReady(next: MapView | null) {
    if (!next) {
      // Provider re-create destroyed the view; drop it and every handle.
      lineRef.current = null;
      setMap(null);
      return;
    }
    lineRef.current = next.line({
      color: ["get", "color"],
      width: 3.5,
      opacity: 0.9,
      testId: "flights",
    });
    setMap(next);
  }

  useEffect(() => {
    if (!map || features.length === 0) return;
    lineRef.current?.set(features);

    const positions: LngLat[] = [];
    for (const feature of features) {
      if (feature.geometry.type !== "LineString") continue;
      for (const position of feature.geometry.coordinates) {
        positions.push(position as LngLat);
      }
    }
    const bounds = boundsOf(positions);
    if (bounds) {
      map.fitBounds(bounds, {
        padding: { top: 80, bottom: 60, left: 50, right: 50 },
      });
    }
  }, [features, map]);

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            {isDesktop ? (
              // No Ionic router in the desktop shell; IonBackButton there
              // falls back to a FULL document navigation.
              <IonButton onClick={() => history.push("/logbook")}>
                <IonIcon slot="start" icon={chevronBackOutline} />
                Logbook
              </IonButton>
            ) : (
              <IonBackButton defaultHref="/logbook" />
            )}
          </IonButtons>
          <IonTitle>All Flights</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent scrollY={false}>
        <div className="all-flights-map">
          <MapCanvas base={view} onReady={handleReady} />
          <div className="composite-legend">
            Oldest → newest
            <div className="legend-bar" />
          </div>
          <div className="map-overlay">
            {map?.supportsSatellite && (
              <ViewToggle view={view} onChange={changeView} />
            )}
          </div>
        </div>
      </IonContent>
    </IonPage>
  );
}
