import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonPage,
  IonTitle,
  IonToolbar,
  useIonViewWillEnter,
} from "@ionic/react";
import type { Feature } from "geojson";
import { chevronBackOutline } from "ionicons/icons";
import { useEffect, useRef, useState } from "react";
import { useHistory } from "react-router-dom";

import { getTrack, listFlights } from "../../storage/db";
import { useAppearance } from "../appTheme";
import ErrorBoundary from "../components/ErrorBoundary";
import CompassButton from "../map/CompassButton";
import MapCanvas from "../map/MapCanvas";
import { boundsOf, type Line, type LngLat, type MapView } from "../map/types";
import useMapView from "../map/useMapView";
import ViewToggle from "../map/ViewToggle";
import { useIsDesktop } from "../useIsDesktop";

import mapCss from "../map/map.module.css";
import styles from "./AllFlightsMapPage.module.css";

const OLDEST_HUE = 290;
const NEWEST_HUE = 175;

function rampColor(t: number): string {
  const hue = OLDEST_HUE + (NEWEST_HUE - OLDEST_HUE) * t;
  const lightness = 48 + 14 * t;
  return `hsl(${Math.round(hue)}, 85%, ${Math.round(lightness)}%)`;
}

/**
 * The composite "all flights" map. The shell keeps the chrome the outlet's
 * stack transitions need — IonPage, the IonHeader with its back button, and
 * the IonContent — mounted through a crash; the boundary swaps only the map
 * body inside. The header needs isDesktop/history, so those stay in the
 * shell; the rest is map logic in AllFlightsMapBody. See PR #133.
 */
export default function AllFlightsMapPage() {
  const history = useHistory();
  const isDesktop = useIsDesktop();
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
        <ErrorBoundary name="logbook">
          <AllFlightsMapBody />
        </ErrorBoundary>
      </IonContent>
    </IonPage>
  );
}

function AllFlightsMapBody() {
  const appearance = useAppearance();
  const [view, changeView] = useMapView();
  const [features, setFeatures] = useState<Feature[]>([]);
  const [map, setMap] = useState<MapView | null>(null);
  const lineRef = useRef<Line | null>(null);
  const skipArrivalFitRef = useRef(false);

  function load() {
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

  function handleReady(next: MapView | null) {
    if (!next) {
      // Provider re-create destroyed the view; drop it and every handle.
      lineRef.current = null;
      setMap(null);
      return;
    }
    // A re-created map that inherited its camera (appearance flip) must
    // not be re-fit on arrival — the pilot's place survives the flip.
    skipArrivalFitRef.current = next.restoredCamera === true;
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
      if (skipArrivalFitRef.current) {
        skipArrivalFitRef.current = false;
      } else {
        map.fitBounds(bounds, {
          padding: { top: 80, bottom: 60, left: 50, right: 50 },
        });
      }
    }
  }, [features, map]);

  return (
    // Full-screen on phone (below the header, so the map keeps the device
    // insets — bottom home indicator, landscape notch); a pane in the desktop
    // shell, where env() is 0. Nothing to consume.
    <div className={styles.root} data-testid="all-flights-map">
      <MapCanvas base={view} appearance={appearance} onReady={handleReady}>
        <div className={styles.legend} data-testid="composite-legend">
          Oldest → newest
          <div className={styles.bar} />
        </div>
        <div className={mapCss.overlay} data-testid="map-overlay">
          {map && <CompassButton map={map} />}
          {map?.supportsSatellite && (
            <ViewToggle view={view} onChange={changeView} />
          )}
        </div>
      </MapCanvas>
    </div>
  );
}
