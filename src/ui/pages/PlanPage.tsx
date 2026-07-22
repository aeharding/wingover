import {
  IonContent,
  IonIcon,
  IonPage,
  useIonActionSheet,
  useIonViewWillEnter,
} from "@ionic/react";
import { locateOutline } from "ionicons/icons";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { getCurrentPosition } from "../../engine/currentPosition";
import { formatDistance } from "../../flight/format";
import { haversineMeters } from "../../flight/stats";
import {
  deleteAllPins,
  deletePin,
  listPins,
  onDocsChanged,
  type Pin,
  savePin,
  updatePin,
} from "../../storage/db";
import { useAppearance } from "../appTheme";
import CompassButton from "../map/CompassButton";
import MapCanvas from "../map/MapCanvas";
import {
  boundsOf,
  type Line,
  type LngLat,
  type MapView,
  type MarkerLayer,
  type MarkerSpec,
  PLANNED_COLOR,
} from "../map/types";
import useMapView from "../map/useMapView";
import ViewToggle from "../map/ViewToggle";
import { useSettings } from "../settings/SettingsContext";
import { useIsDesktop } from "../useIsDesktop";

import "./PlanPage.css";

// The plan's pins ARE the planned waypoints, so the route + pins are green to
// match how they read in flight (see PLANNED_COLOR).
const ROUTE_COLOR = PLANNED_COLOR;

function pinSvg(color: string, label: string): string {
  return `<svg viewBox="0 0 24 32" width="28" height="37" xmlns="http://www.w3.org/2000/svg"><path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 20 12 20s12-11 12-20C24 5.4 18.6 0 12 0z" fill="${color}"/><circle cx="12" cy="12" r="7" fill="#fff"/><text x="12" y="12" text-anchor="middle" dominant-baseline="central" font-size="9.5" font-weight="700" fill="#000">${label}</text></svg>`;
}

// The DOM element for a midpoint handle: a small dot the color of the line, so
// it reads as a draggable "bump" on the leg. A 0×0 wrapper (centered on the
// coordinate like the aircraft glyph) holds an inner node that translates onto
// that origin; the inner is the touch/drag target, its ::before the visible
// bump. Rendered on every backend.
function handleEl(): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "midpoint-handle";
  wrapper.setAttribute("aria-hidden", "true");
  const dot = document.createElement("div");
  dot.className = "midpoint-handle-dot";
  wrapper.appendChild(dot);
  return wrapper;
}

// Pins form an ordered route (creation order — the same order the flight
// copies at start), drawn as a dashed line to read as "planned", not flown.
function routeCoords(pins: Pin[]): LngLat[] {
  return pins.length < 2
    ? []
    : pins.map((pin): LngLat => [pin.longitude, pin.latitude]);
}

export default function PlanPage() {
  const { units } = useSettings();
  const isDesktop = useIsDesktop();
  const appearance = useAppearance();
  const [presentRouteSheet] = useIonActionSheet();
  const [view, changeView] = useMapView();
  const [pins, setPins] = useState<Pin[]>([]);
  const [map, setMap] = useState<MapView | null>(null);
  const lineRef = useRef<Line | null>(null);
  const markersRef = useRef<MarkerLayer | null>(null);

  // Total route length = sum of the legs between consecutive pins, for
  // planning (matches the idle Fly screen's "Planned route").
  const routeMeters = pins.reduce(
    (sum, pin, i) => (i === 0 ? 0 : sum + haversineMeters(pins[i - 1], pin)),
    0,
  );

  function loadPlan() {
    listPins().then(setPins);
  }

  // Will-enter for the phone shell; a mount effect for the desktop shell
  // (no Ionic lifecycle there). Idempotent gets, so double-firing is free.
  useIonViewWillEnter(() => {
    loadPlan();
  });

  useEffect(() => {
    loadPlan();
    // eslint-safe: loadPlan reads no reactive values.
  }, []);

  // Pins placed on another device appear without a refresh — the feed fires
  // for replicated pulls and local writes alike.
  useEffect(
    () => onDocsChanged("pin", () => void listPins().then(setPins)),
    [],
  );

  async function addPin(point: LngLat) {
    const now = Date.now();
    const pin: Pin = {
      id: crypto.randomUUID(),
      name: "Pin",
      notes: "",
      latitude: point[1],
      longitude: point[0],
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

  async function clearRoute() {
    await deleteAllPins();
    setPins([]);
  }

  // Tapping the route (the distance pill, or the desktop pane's total) opens a
  // bottom sheet whose one destructive option wipes the whole plan. The red
  // action-sheet button IS the confirm — the same deliberate step iOS uses for
  // a destructive choice, so no second alert; the subheader still states the
  // stakes (matching the flight-delete and clip flows), and the count
  // quantifies the loss.
  function openRouteSheet() {
    presentRouteSheet({
      header: "Planned route",
      subHeader: "This cannot be undone.",
      buttons: [
        {
          text: `Delete all ${pins.length} pins`,
          role: "destructive",
          handler: () => void clearRoute(),
        },
        { text: "Cancel", role: "cancel" },
      ],
    });
  }

  // Live during a drag: redraw the route line with this pin at its dragged
  // position, WITHOUT touching state — a setPins here would rebuild the
  // markers and abort the in-flight drag. Effect Event so it reads the latest
  // pins without being a marker-rebuild dependency.
  const previewDrag = useEffectEvent((pinId: string, at: LngLat) => {
    const preview = pins.map((pin) =>
      pin.id === pinId ? { ...pin, longitude: at[0], latitude: at[1] } : pin,
    );
    lineRef.current?.set(routeCoords(preview));
  });

  // On drag release: commit the new position. updatePin does a get-then-put so
  // PouchDB gets the current _rev (a bare savePin would 409-conflict on an
  // existing doc). State updates functionally, so this reads no reactive value.
  async function movePin(pinId: string, at: LngLat) {
    await updatePin(pinId, { longitude: at[0], latitude: at[1] });
    setPins((current) =>
      current.map((pin) =>
        pin.id === pinId
          ? { ...pin, longitude: at[0], latitude: at[1], updatedAt: Date.now() }
          : pin,
      ),
    );
  }

  // Live while dragging a midpoint "+" handle: redraw the line with the new
  // point spliced into leg `legIndex`, so the route follows without committing.
  const previewInsert = useEffectEvent((legIndex: number, at: LngLat) => {
    const coords: LngLat[] = [];
    pins.forEach((pin, index) => {
      coords.push([pin.longitude, pin.latitude]);
      if (index === legIndex) coords.push(at);
    });
    lineRef.current?.set(coords);
  });

  // On release of a midpoint handle: insert a new pin between the leg's two
  // ends. Route order is by createdAt (listPins sorts on it), so the new pin
  // takes a timestamp between its neighbors to land in the right spot.
  const insertPinAfter = useEffectEvent(
    async (legIndex: number, at: LngLat) => {
      const before = pins[legIndex];
      const after = pins[legIndex + 1];
      if (!before || !after) return;
      const pin: Pin = {
        id: crypto.randomUUID(),
        name: "Pin",
        notes: "",
        latitude: at[1],
        longitude: at[0],
        createdAt: (before.createdAt + after.createdAt) / 2,
        updatedAt: Date.now(),
      };
      await savePin(pin);
      setPins((current) => {
        const index = current.findIndex((p) => p.id === after.id);
        const next = [...current];
        next.splice(index < 0 ? next.length : index, 0, pin);
        return next;
      });
    },
  );

  function handleReady(next: MapView | null) {
    if (!next) {
      // Provider re-create destroyed the view; drop it and every handle.
      lineRef.current = null;
      markersRef.current = null;
      setMap(null);
      return;
    }
    lineRef.current = next.line({
      color: ROUTE_COLOR,
      width: 3,
      dash: [1.5, 2],
      opacity: 0.9,
    });
    markersRef.current = next.markers();
    next.on("longpress", (event) => addPin(event.at));
    setMap(next);
  }

  // Initial camera, once — reads whatever pins exist when the map arrives.
  const frameInitial = useEffectEvent((next: MapView) => {
    if (pins.length === 1) {
      next.moveTo(
        { center: [pins[0].longitude, pins[0].latitude], zoom: 12 },
        { animate: false },
      );
    } else if (pins.length > 1) {
      const bounds = boundsOf(routeCoords(pins));
      if (bounds) next.fitBounds(bounds, { padding: 60 });
    }
  });

  useEffect(() => {
    if (map) frameInitial(map);
  }, [map]);

  useEffect(() => {
    if (!map) return;
    lineRef.current?.set(routeCoords(pins));
    map.el.setAttribute(
      "data-route-coords",
      pins.length < 2
        ? ""
        : pins
            .map(
              (pin) => `${pin.latitude.toFixed(5)},${pin.longitude.toFixed(5)}`,
            )
            .join(";"),
    );
    const specs: MarkerSpec[] = pins.map((pin, index) => {
      // One color for every pin — the numbers carry order and direction now.
      const color = ROUTE_COLOR;
      // Route order (1, 2, 3…): shows the sequence and thus the direction.
      const label = String(index + 1);
      const element = document.createElement("button");
      element.className = "pin-marker";
      element.setAttribute("aria-label", `Pin ${label}`);
      element.setAttribute("data-testid", "pin-marker");
      element.setAttribute("data-lat", String(pin.latitude));
      element.setAttribute("data-lng", String(pin.longitude));
      element.innerHTML = pinSvg(color, label);
      return {
        id: pin.id,
        at: [pin.longitude, pin.latitude],
        el: element,
        color,
        label,
        anchor: "bottom",
        onClick: () => removePin(pin.id),
        draggable: true,
        onDrag: (at) => previewDrag(pin.id, at),
        onDragEnd: (at) => movePin(pin.id, at),
      };
    });
    // A "+" handle at each leg's midpoint — drag it out to insert a pin there.
    const handles: MarkerSpec[] = [];
    for (let leg = 0; leg < pins.length - 1; leg++) {
      const a = pins[leg];
      const b = pins[leg + 1];
      handles.push({
        id: `handle-${a.id}-${b.id}`,
        at: [(a.longitude + b.longitude) / 2, (a.latitude + b.latitude) / 2],
        el: handleEl(),
        // Render the small DOM dot on-line rather than a heavy native balloon.
        custom: true,
        anchor: "center",
        draggable: true,
        onDrag: (at) => previewInsert(leg, at),
        onDragEnd: (at) => insertPinAfter(leg, at),
      });
    }
    markersRef.current?.set([...specs, ...handles]);
  }, [pins, map]);

  async function locate() {
    try {
      const position = await getCurrentPosition();
      map?.moveTo(
        { center: [position.longitude, position.latitude], zoom: 12 },
        { animate: "fly" },
      );
    } catch (error) {
      console.warn("locate failed:", error);
    }
  }

  return (
    <IonPage>
      <IonContent scrollY={false}>
        <div className="plan-split">
          {isDesktop && (
            <aside className="plan-pane" data-testid="plan-pane">
              <div className="plan-pane-rows">
                {pins.length === 0 ? (
                  <div className="plan-pane-empty">
                    Long-press the map to drop a pin: launches, LZs, fuel stops,
                    hazards.
                  </div>
                ) : (
                  pins.map((pin, index) => (
                    <button
                      key={pin.id}
                      className="plan-pane-row"
                      onClick={() =>
                        map?.moveTo(
                          {
                            center: [pin.longitude, pin.latitude],
                            zoom: 13,
                          },
                          { animate: true },
                        )
                      }
                    >
                      <span className="dot">{index + 1}</span>
                      <span>
                        <h3>{pin.name || `Pin ${index + 1}`}</h3>
                        {pin.notes && <p>{pin.notes}</p>}
                      </span>
                    </button>
                  ))
                )}
              </div>
              {routeMeters > 0 && (
                <div className="plan-pane-route">
                  <span>Route: {formatDistance(routeMeters, units)}</span>
                  <button
                    className="plan-pane-clear"
                    data-testid="plan-clear-route"
                    onClick={openRouteSheet}
                  >
                    Clear route
                  </button>
                </div>
              )}
            </aside>
          )}
          <div className="plan-map">
            <MapCanvas
              base={view}
              appearance={appearance}
              onReady={handleReady}
            />
            <div className="map-overlay">
              {map && <CompassButton map={map} />}
              <button
                className="map-button"
                aria-label="Center on me"
                onClick={locate}
              >
                <IonIcon icon={locateOutline} />
              </button>
              {map?.supportsSatellite && (
                <ViewToggle view={view} onChange={changeView} />
              )}
            </div>
            {routeMeters > 0 && (
              <button
                className="plan-distance"
                data-testid="plan-distance"
                onClick={openRouteSheet}
              >
                Route: {formatDistance(routeMeters, units)}
              </button>
            )}
          </div>
        </div>
      </IonContent>
    </IonPage>
  );
}
