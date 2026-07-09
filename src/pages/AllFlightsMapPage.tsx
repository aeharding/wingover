import {
  IonBackButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonPage,
  IonTitle,
  IonToolbar,
  useIonViewWillEnter,
} from "@ionic/react";
import type { Feature } from "geojson";
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";

import MapView, { type MapLibreModule } from "../map/MapView";
import { labelInsertionPoint } from "../map/layers";
import ViewToggle from "../map/ViewToggle";
import type { MapViewKind } from "../map/config";
import { getSetting, getTrack, listFlights, setSetting } from "../storage/db";
import "./AllFlightsMapPage.css";

const OLDEST_HUE = 290;
const NEWEST_HUE = 175;

function rampColor(t: number): string {
  const hue = OLDEST_HUE + (NEWEST_HUE - OLDEST_HUE) * t;
  const lightness = 48 + 14 * t;
  return `hsl(${Math.round(hue)}, 85%, ${Math.round(lightness)}%)`;
}

export default function AllFlightsMapPage() {
  const [view, setView] = useState<MapViewKind>("street");
  const [features, setFeatures] = useState<Feature[]>([]);
  const [mapReady, setMapReady] = useState(false);
  const mapRef = useRef<MapLibreMap | null>(null);
  const libRef = useRef<MapLibreModule | null>(null);
  const featuresRef = useRef<Feature[]>([]);
  featuresRef.current = features;

  useIonViewWillEnter(() => {
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
  });

  function changeView(value: MapViewKind) {
    setView(value);
    setSetting("mapView", value);
  }

  function ensureFlightsLayer(map: MapLibreMap) {
    if (!map.isStyleLoaded()) return;
    if (map.getSource("flights") || featuresRef.current.length === 0) return;
    map.addSource("flights", {
      type: "geojson",
      data: { type: "FeatureCollection", features: featuresRef.current },
    });
    const firstSymbol = labelInsertionPoint(map);
    map.addLayer(
      {
        id: "flights",
        type: "line",
        source: "flights",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": 3.5,
          "line-opacity": 0.9,
        },
      },
      firstSymbol,
    );
    map.getContainer().setAttribute("data-flights-layer", "true");
  }

  function handleReady(map: MapLibreMap, lib: MapLibreModule) {
    mapRef.current = map;
    libRef.current = lib;
    map.on("styledata", () => ensureFlightsLayer(map));
    map.on("idle", () => ensureFlightsLayer(map));
    setMapReady(true);
  }

  useEffect(() => {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!map || !lib || !mapReady || features.length === 0) return;

    const source = map.getSource("flights") as GeoJSONSource | undefined;
    if (source) {
      source.setData({ type: "FeatureCollection", features });
    } else {
      ensureFlightsLayer(map);
    }

    const bounds = new lib.LngLatBounds();
    for (const feature of features) {
      if (feature.geometry.type !== "LineString") continue;
      for (const position of feature.geometry.coordinates) {
        bounds.extend(position as [number, number]);
      }
    }
    map.fitBounds(bounds, {
      padding: { top: 80, bottom: 60, left: 50, right: 50 },
      animate: false,
    });
  }, [features, mapReady]);

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <IonBackButton defaultHref="/logbook" />
          </IonButtons>
          <IonTitle>All Flights</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <div className="all-flights-map">
          <MapView view={view} onReady={handleReady} />
          <div className="composite-legend">
            Oldest → newest
            <div className="legend-bar" />
          </div>
          <div className="map-overlay">
            <ViewToggle view={view} onChange={changeView} />
          </div>
        </div>
      </IonContent>
    </IonPage>
  );
}
