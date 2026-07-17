import {
  IonActionSheet,
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonPage,
  IonTextarea,
  IonTitle,
  IonToolbar,
  useIonRouter,
  useIonViewWillEnter,
} from "@ionic/react";
import {
  contractOutline,
  ellipsisHorizontal,
  expandOutline,
} from "ionicons/icons";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router";

import { isTauri } from "../../engine/platform";
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
  getTrack,
  updateFlight,
} from "../../storage/db";
import { getSetting, setSetting } from "../../storage/local";
import FlightList from "../logbook/FlightList";
import { useFlights } from "../logbook/useFlights";
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
import { useIsDesktop } from "../useIsDesktop";

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
  const [mapFull, setMapFull] = useState(false);
  // Mirrors mapFull for the async fullscreen grant below: two quick taps
  // can fold the map before the browser grants fullscreen, and the grant
  // callback must see the CURRENT intent, not the one it closed over.
  const mapFullRef = useRef(false);
  const contentRef = useRef<HTMLIonContentElement>(null);
  // The desktop split: the logbook list rides along in a left pane, and
  // selecting a flight replaces this page (root direction) instead of
  // stacking map-holding detail pages.
  const isDesktop = useIsDesktop();
  const { flights, refresh: refreshFlights } = useFlights();
  const paneRef = useRef<HTMLDivElement>(null);
  const [draftName, setDraftName] = useState("");
  const [draftLaunch, setDraftLaunch] = useState("");
  const [draftNotes, setDraftNotes] = useState("");
  const lineRef = useRef<Line | null>(null);
  const planLineRef = useRef<Line | null>(null);
  const markersRef = useRef<MarkerLayer | null>(null);

  const load = useCallback(() => {
    getFlight(id).then((found) => {
      setFlight(found);
      setDraftName(found?.name ?? "");
      setDraftLaunch(found?.launchName ?? "");
      setDraftNotes(found?.notes ?? "");
    });
    getTrack(id).then(setTrack);
    getSetting("mapView").then((value) => {
      if (value === "street" || value === "satellite") setView(value);
    });
  }, [id]);

  useIonViewWillEnter(() => {
    load();
  }, [load]);

  // Desktop pane navigation can swap the id without an Ionic page
  // transition; the loads are idempotent gets, so double-firing on a
  // normal entry costs nothing.
  useEffect(() => {
    load();
  }, [load]);

  function changeView(value: MapViewKind) {
    setView(value);
    setSetting("mapView", value);
  }

  // Full screen means NO bars: the header and tab bar go (the body class
  // hides ion-tab-bar, which lives outside this page), and on the PWA the
  // Fullscreen API sheds the browser chrome too — where it exists (iPhone
  // Safari has none for elements; the native app has no chrome to shed).
  // Everything reverses in the cleanup, so navigating away while expanded
  // can't strand a hidden tab bar or a fullscreened document.
  useEffect(() => {
    mapFullRef.current = mapFull;
    if (!mapFull) return;
    document.body.classList.add("flight-map-full");
    if (!isTauri()) {
      void document.documentElement
        .requestFullscreen?.()
        .then(() => {
          // Folded again before the grant landed: leave immediately, or the
          // browser stays fullscreen with no listener left to notice.
          if (!mapFullRef.current && document.fullscreenElement) {
            void document.exitFullscreen().catch(() => {});
          }
        })
        .catch(() => {});
    }
    // Esc / the system gesture exits browser fullscreen without touching our
    // button — fold the map back down so the two never disagree.
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

  function commitDetails() {
    if (!flight) return;
    const name = draftName.trim() || flight.name;
    const launchName = draftLaunch.trim() || undefined;
    const notes = draftNotes;
    if (
      name === flight.name &&
      notes === flight.notes &&
      launchName === flight.launchName
    ) {
      return;
    }
    setDraftName(name);
    setDraftLaunch(launchName ?? "");
    const changes: Partial<
      Pick<Flight, "name" | "notes" | "launchName" | "launchAt">
    > = { name, notes, launchName };
    // Flights recorded before launchAt existed have no coordinates to match
    // against — capture them from the loaded track the moment the pilot names
    // the launch, so future flights from this field inherit the name.
    if (launchName && !flight.launchAt && track.length > 0) {
      changes.launchAt = [track[0].longitude, track[0].latitude];
    }
    void updateFlight(flight.id, changes);
    setFlight({ ...flight, ...changes });
  }

  function handleReady(next: MapView | null) {
    if (!next) {
      // Provider re-create destroyed the view; drop it and every handle.
      planLineRef.current = null;
      lineRef.current = null;
      markersRef.current = null;
      setMap(null);
      return;
    }
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

    lineRef.current?.set(
      track.map((fix): LngLat => [fix.longitude, fix.latitude]),
    );

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
    // overshoots the track (unreached waypoints) still frames fully. Extra
    // bottom padding keeps the track clear of the view toggle.
    const bounds = boundsOf([
      ...track.map((fix): LngLat => [fix.longitude, fix.latitude]),
      ...plannedRoute,
    ]);
    if (bounds) {
      map.fitBounds(bounds, {
        padding: { top: 40, bottom: 76, left: 40, right: 40 },
      });
    }
  }, [track, map, flight?.id, flight?.plannedRoute]);

  const stats = flight?.stats;

  return (
    <IonPage>
      {!mapFull && (
        <IonHeader>
          <IonToolbar>
            {!isDesktop && (
              <IonButtons slot="start">
                <IonBackButton defaultHref="/logbook" />
              </IonButtons>
            )}
            {/* The when, not the name — the name is the editable field below,
                and printing it twice an inch apart read as a bug. */}
            <IonTitle>
              {flight
                ? new Date(flight.startedAt).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })
                : "Flight"}
            </IonTitle>
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
      )}
      <IonContent ref={contentRef} scrollY={!mapFull && !isDesktop}>
        {/* Desktop: the logbook rides along in a left pane and this page IS
            the split's detail seat. Phone: both wrappers are display:
            contents, so the layout is exactly the phone app. */}
        <div
          className={
            isDesktop
              ? `detail-split${mapFull ? " no-pane" : ""}`
              : "detail-plain"
          }
        >
          {isDesktop && (
            <aside className="logbook-pane" ref={paneRef}>
              <FlightList
                flights={flights}
                units={units}
                scrollRef={paneRef}
                desktop
                totalsStrip
                selectedId={id}
                onDeleted={(deleted) => {
                  refreshFlights();
                  // The open flight just died; its seat has to go too.
                  if (deleted.id === id) router.push("/logbook", "root");
                }}
              />
            </aside>
          )}
          <div className={isDesktop ? "detail-main" : "detail-plain"}>
        {/* Map and details split the screen instead of a card floating over
            the track — nothing overlaps the flight anymore, and the stats get
            room to breathe below. Expandable to full screen: the map is the
            main event, and the split is only the default. */}
        <div className={`flight-detail-map${mapFull ? " map-full" : ""}`}>
          <MapCanvas base={view} onReady={handleReady} />
          <div className="map-overlay">
            <button
              className="map-button"
              aria-label={mapFull ? "Shrink map" : "Expand map"}
              data-testid="map-expand"
              onClick={() => {
                // The map is the first child of the scroll area, so top is
                // where full screen is — without this, expanding while
                // scrolled down shows the middle of the details instead.
                // Desktop needs no scroll: full screen is an overlay there,
                // and ion-content isn't the scroller anyway.
                if (!mapFull && !isDesktop) {
                  void contentRef.current?.scrollToTop();
                }
                setMapFull(!mapFull);
              }}
            >
              <IonIcon icon={mapFull ? contractOutline : expandOutline} />
            </button>
            {map?.supportsSatellite && (
              <ViewToggle view={view} onChange={changeView} />
            )}
          </div>
        </div>
        {flight && stats && (
          <>
            <IonList>
              <IonItem>
                {/* Ionic defaults autocapitalize to "off" (unlike bare HTML
                    inputs), so the iOS keyboard never shifts without these. */}
                <IonInput
                  label="Name"
                  clearInput
                  autocapitalize="words"
                  value={draftName}
                  aria-label="Flight name"
                  onIonInput={(event) => setDraftName(event.detail.value ?? "")}
                  onIonBlur={commitDetails}
                />
              </IonItem>
              <IonItem>
                <IonInput
                  label="Launch"
                  clearInput
                  autocapitalize="words"
                  placeholder="Add location"
                  value={draftLaunch}
                  aria-label="Launch location"
                  onIonInput={(event) =>
                    setDraftLaunch(event.detail.value ?? "")
                  }
                  onIonBlur={commitDetails}
                />
              </IonItem>
              <IonItem>
                {/* rows 1: one line empty (a textarea's native default is
                    two), growing with content. */}
                <IonTextarea
                  label="Notes"
                  autocapitalize="sentences"
                  placeholder="Wing, motor, conditions…"
                  rows={1}
                  autoGrow
                  value={draftNotes}
                  aria-label="Flight notes"
                  onIonInput={(event) =>
                    setDraftNotes(event.detail.value ?? "")
                  }
                  onIonBlur={commitDetails}
                />
              </IonItem>
            </IonList>
            <IonList>
              <Stat
                label="Duration"
                value={formatDuration(stats.durationSeconds)}
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
