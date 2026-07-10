import {
  IonContent,
  IonIcon,
  IonPage,
  useIonViewWillEnter,
} from "@ionic/react";
import { locateOutline } from "ionicons/icons";
import type { Map as MapLibreMap, Marker } from "maplibre-gl";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import type { MapViewKind } from "../map/config";
import MapView, { type MapLibreModule } from "../map/MapView";
import ViewToggle from "../map/ViewToggle";
import {
  deletePin,
  getSetting,
  listPins,
  type Pin,
  savePin,
  setSetting,
} from "../storage/db";

import "./PlanPage.css";

const PIN_SVG = `<svg viewBox="0 0 24 32" width="28" height="37" xmlns="http://www.w3.org/2000/svg"><path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 20 12 20s12-11 12-20C24 5.4 18.6 0 12 0z" fill="#e0483a"/><circle cx="12" cy="12" r="5" fill="#fff"/></svg>`;

export default function PlanPage() {
  const [view, setView] = useState<MapViewKind>("street");
  const [pins, setPins] = useState<Pin[]>([]);
  const [mapContext, setMapContext] = useState<{
    map: MapLibreMap;
    lib: MapLibreModule;
  } | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const libRef = useRef<MapLibreModule | null>(null);
  const markersRef = useRef(new Map<string, Marker>());

  useIonViewWillEnter(() => {
    listPins().then(setPins);
    getSetting("mapView").then((value) => {
      if (value === "street" || value === "satellite") setView(value);
    });
  });

  function changeView(value: MapViewKind) {
    setView(value);
    setSetting("mapView", value);
  }

  const setupMap = useEffectEvent((map: MapLibreMap, lib: MapLibreModule) => {
    mapRef.current = map;
    libRef.current = lib;
    const existing = pins;
    if (existing.length === 1) {
      map.jumpTo({
        center: [existing[0].longitude, existing[0].latitude],
        zoom: 12,
      });
    } else if (existing.length > 1) {
      const bounds = new lib.LngLatBounds();
      for (const pin of existing) bounds.extend([pin.longitude, pin.latitude]);
      map.fitBounds(bounds, { padding: 60, animate: false });
    }
  });

  useEffect(() => {
    if (mapContext) setupMap(mapContext.map, mapContext.lib);
  }, [mapContext]);

  async function addPin(point: { longitude: number; latitude: number }) {
    const now = Date.now();
    const pin: Pin = {
      id: crypto.randomUUID(),
      name: "Pin",
      notes: "",
      latitude: point.latitude,
      longitude: point.longitude,
      createdAt: now,
      updatedAt: now,
    };
    await savePin(pin);
    setPins((current) => [...current, pin]);
  }

  async function removePin(pinId: string) {
    await deletePin(pinId);
    setPins((current) => current.filter((pin) => pin.id !== pinId));
  }

  useEffect(() => {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!map || !lib || !mapContext) return;
    for (const marker of markersRef.current.values()) marker.remove();
    markersRef.current.clear();
    for (const pin of pins) {
      const element = document.createElement("button");
      element.className = "pin-marker";
      element.setAttribute("aria-label", "Pin");
      element.setAttribute("data-testid", "pin-marker");
      element.innerHTML = PIN_SVG;
      element.addEventListener("click", (event) => {
        event.stopPropagation();
        removePin(pin.id);
      });
      const marker = new lib.Marker({ element, anchor: "bottom" })
        .setLngLat([pin.longitude, pin.latitude])
        .addTo(map);
      markersRef.current.set(pin.id, marker);
    }
  }, [pins, mapContext]);

  function locate() {
    navigator.geolocation.getCurrentPosition((position) => {
      mapRef.current?.flyTo({
        center: [position.coords.longitude, position.coords.latitude],
        zoom: 12,
      });
    });
  }

  return (
    <IonPage>
      <IonContent scrollY={false}>
        <MapView
          view={view}
          onReady={(map, lib) => setMapContext({ map, lib })}
          onLongPress={addPin}
        />
        <div className="map-overlay">
          <button
            className="map-button"
            aria-label="Center on me"
            onClick={locate}
          >
            <IonIcon icon={locateOutline} />
          </button>
          <ViewToggle view={view} onChange={changeView} />
        </div>
      </IonContent>
    </IonPage>
  );
}
