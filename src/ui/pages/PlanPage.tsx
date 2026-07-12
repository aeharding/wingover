import {
  IonContent,
  IonIcon,
  IonPage,
  useIonViewWillEnter,
} from "@ionic/react";
import type { FeatureCollection } from "geojson";
import { locateOutline } from "ionicons/icons";
import type { GeoJSONSource, Map as MapLibreMap, Marker } from "maplibre-gl";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { getCurrentPosition } from "../../engine/currentPosition";
import {
  deletePin,
  getSetting,
  listPins,
  type Pin,
  savePin,
  setSetting,
} from "../../storage/db";
import type { MapViewKind } from "../map/config";
import MapView, { type MapLibreModule } from "../map/MapView";
import ViewToggle from "../map/ViewToggle";

import "./PlanPage.css";

// Route colors follow the logbook endpoint language: green = start,
// red = end, blue in between (and for the planned line itself).
const ROUTE_START_COLOR = "#35e06a";
const ROUTE_END_COLOR = "#e0483a";
const ROUTE_COLOR = "#4cc2ff";

function pinSvg(color: string): string {
  return `<svg viewBox="0 0 24 32" width="28" height="37" xmlns="http://www.w3.org/2000/svg"><path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 20 12 20s12-11 12-20C24 5.4 18.6 0 12 0z" fill="${color}"/><circle cx="12" cy="12" r="5" fill="#fff"/></svg>`;
}

// Pins form an ordered route (creation order — the same order the flight
// copies at start), drawn as a dashed line to read as "planned", not flown.
function routeData(pins: Pin[]): FeatureCollection {
  return {
    type: "FeatureCollection",
    features:
      pins.length < 2
        ? []
        : [
            {
              type: "Feature",
              properties: {},
              geometry: {
                type: "LineString",
                coordinates: pins.map((pin) => [pin.longitude, pin.latitude]),
              },
            },
          ],
  };
}

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

  const ensureRouteLayer = useEffectEvent((map: MapLibreMap) => {
    if (!map.isStyleLoaded()) return;
    if (map.getSource("plan-route")) return;
    map.addSource("plan-route", { type: "geojson", data: routeData(pins) });
    map.addLayer({
      id: "plan-route",
      type: "line",
      source: "plan-route",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ROUTE_COLOR,
        "line-width": 3,
        "line-dasharray": [1.5, 2],
        "line-opacity": 0.9,
      },
    });
  });

  const setupMap = useEffectEvent((map: MapLibreMap, lib: MapLibreModule) => {
    mapRef.current = map;
    libRef.current = lib;
    map.on("styledata", () => ensureRouteLayer(map));
    map.on("idle", () => ensureRouteLayer(map));
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
    const source = map.getSource("plan-route") as GeoJSONSource | undefined;
    if (source) {
      source.setData(routeData(pins));
    } else {
      ensureRouteLayer(map);
    }
    map
      .getContainer()
      .setAttribute(
        "data-route-coords",
        pins.length < 2
          ? ""
          : pins
              .map(
                (pin) =>
                  `${pin.latitude.toFixed(5)},${pin.longitude.toFixed(5)}`,
              )
              .join(";"),
      );
    for (const marker of markersRef.current.values()) marker.remove();
    markersRef.current.clear();
    pins.forEach((pin, index) => {
      const isTail = index === pins.length - 1;
      const color =
        isTail && pins.length > 1
          ? ROUTE_END_COLOR
          : index === 0
            ? ROUTE_START_COLOR
            : ROUTE_COLOR;
      const element = document.createElement("button");
      // The tail pin is enlarged + haloed: it is what a tap deletes next
      // and where the next long-press extends the route from.
      element.className = isTail ? "pin-marker pin-tail" : "pin-marker";
      element.setAttribute("aria-label", "Pin");
      element.setAttribute("data-testid", "pin-marker");
      element.setAttribute("data-lat", String(pin.latitude));
      element.setAttribute("data-lng", String(pin.longitude));
      element.innerHTML = pinSvg(color);
      element.addEventListener("click", (event) => {
        event.stopPropagation();
        removePin(pin.id);
      });
      const marker = new lib.Marker({ element, anchor: "bottom" })
        .setLngLat([pin.longitude, pin.latitude])
        .addTo(map);
      markersRef.current.set(pin.id, marker);
    });
  }, [pins, mapContext]);

  async function locate() {
    try {
      const position = await getCurrentPosition();
      mapRef.current?.flyTo({
        center: [position.longitude, position.latitude],
        zoom: 12,
      });
    } catch (error) {
      console.warn("locate failed:", error);
    }
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
