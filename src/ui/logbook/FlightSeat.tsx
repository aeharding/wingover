import { IonIcon, IonInput, IonItem, IonList, IonTextarea } from "@ionic/react";
import {
  chevronDownOutline,
  chevronUpOutline,
  contractOutline,
  ellipsisHorizontal,
  expandOutline,
} from "ionicons/icons";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { isTauri } from "../../engine/platform";
import { useAppearance } from "../appTheme";
import { cx } from "../cx";
import { afterNextFrame } from "../map/afterFrame";
import CompassButton from "../map/CompassButton";
import MapCanvas from "../map/MapCanvas";
import MapCluster from "../map/MapCluster";
import {
  ACCENT_CYAN,
  boundsOf,
  type Line,
  type LngLat,
  type MapView,
  type MarkerLayer,
  PLAN_LINE_COLOR,
} from "../map/types";
import useMapView from "../map/useMapView";
import ViewToggle from "../map/ViewToggle";
import { useReplayDrawer } from "../replay/useReplayDrawer";
import { useSettings } from "../settings/SettingsContext";
import { endpointMarker } from "./endpointMarker";
import FlightStats from "./FlightStats";
import { useFlightDoc } from "./useFlightDoc";
import { useFlightDrafts } from "./useFlightDrafts";
import { useFlightOptionsSheet } from "./useFlightOptionsSheet";

import mapCss from "../map/map.module.css";
import seat from "./FlightSeat.module.css";

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
  const { flight, setFlight, track } = useFlightDoc(id);
  const { drafts, setDraft, commit } = useFlightDrafts(
    flight,
    setFlight,
    track,
  );
  const appearance = useAppearance();
  const [view, changeView] = useMapView();
  const [map, setMap] = useState<MapView | null>(null);
  const [mapFull, setMapFull] = useState(false);
  const [cardOpen, setCardOpen] = useState(true);
  const mapFullRef = useRef(false);
  const wasFullRef = useRef(false);
  const lineRef = useRef<Line | null>(null);
  const planLineRef = useRef<Line | null>(null);
  const markersRef = useRef<MarkerLayer | null>(null);
  const skipArrivalFrameRef = useRef(false);
  // The replay pane slides open under the seat map; closes with a
  // selection swap or when the section is URL-hidden.
  const replay = useReplayDrawer(map, track, flight, active, true);

  const openOptions = useFlightOptionsSheet({
    flight,
    track,
    active,
    // The clip editors open in the pane under the seat map.
    onBeginClip: replay.beginClip,
    onDeleted,
  });

  // Full screen means NO chrome: the list pane, seat header and card hide
  // via the body class (see the shell + seat modules), the tab rail goes with it, and
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
    // A re-created map that inherited its camera (appearance flip) must
    // not be re-framed on arrival; one skip only — the next content
    // change (selection switch, clip rewrite) frames as always.
    skipArrivalFrameRef.current = next.restoredCamera === true;
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

  // Draw-along replay owns the track line while active: the driver draws
  // the flown prefix, so the full line here goes blank. An Effect Event
  // shared by the main content effect AND the toggle effect below, so
  // toggling never re-frames the camera.
  const applyTrackVisibility = useEffectEvent(() => {
    if (!map || track.length === 0) return;
    lineRef.current?.set(
      replay.trackHidden
        ? []
        : track.map((fix): LngLat => [fix.longitude, fix.latitude]),
    );
  });

  useEffect(() => {
    applyTrackVisibility();
  }, [replay.trackHidden]);

  useEffect(() => {
    // Collapsing from full screen EASES back to the framed track instead of
    // jump-cutting (the jump read as a glitchy re-north; a bounds fit is
    // north-up by construction). Other refit causes stay instant.
    const collapsing = wasFullRef.current && !mapFull;
    wasFullRef.current = mapFull;
    if (!map) return;
    if (track.length === 0) {
      // Between selections: blank the previous flight's content.
      lineRef.current?.set([]);
      planLineRef.current?.set([]);
      markersRef.current?.set([]);
      return;
    }

    applyTrackVisibility();

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
        el: endpointMarker("launch", "launch-marker"),
        color: "#22a04a",
        label: "▶",
        glyphColor: "#ffffff",
      },
      {
        id: "landing",
        at: [landing.longitude, landing.latitude],
        el: endpointMarker("landing", "landing-marker"),
        color: "#e0483a",
        label: "■",
        glyphColor: "#ffffff",
      },
    ]);

    const bounds = boundsOf([
      ...track.map((fix): LngLat => [fix.longitude, fix.latitude]),
      ...plannedRoute,
    ]);
    if (!bounds) return;
    if (skipArrivalFrameRef.current) {
      skipArrivalFrameRef.current = false;
      return;
    }
    // The fullscreen toggle resizes the map's container in this same
    // commit; fit only after the backend has adopted the new size (see
    // afterNextFrame) so the bounds math uses the real viewport.
    return afterNextFrame(() => {
      map.fitBounds(bounds, {
        // Right padding clears the OPEN card, always: collapsing must not
        // jump the camera around — it just reveals more of the map that
        // was under the card. Full screen hides the card entirely, so the
        // track expands to the whole viewport instead — including when
        // the arrow keys switch flights while full screen.
        padding: mapFull
          ? { top: 56, bottom: 56, left: 56, right: 56 }
          : { top: 56, bottom: 56, left: 56, right: 440 },
        animate: collapsing,
      });
    });
  }, [track, map, flight?.id, flight?.plannedRoute, mapFull]);

  const stats = flight?.stats;

  return (
    <div className={seat.root}>
      {/* No header bar: the map runs to the top of the seat; the title,
          date, and options live in the floating card. Embedded, the map is
          at the shell's right/top/bottom device edges (it keeps those) but
          the rail + pane cover its left (zeroed by .desktop-main); full
          screen the rail hides and body.flight-map-full restores the left
          edge for the whole seat (see FlightSeat.module.css). When the scrub docks
          below, IT owns the bottom, so the map consumes it (the drawer is a
          sibling and keeps its own). */}
      <div
        className={cx(seat.map, replay.isOpen && "consume-bottom")}
        data-testid="seat-map"
      >
        <MapCanvas base={view} appearance={appearance} onReady={handleReady}>
          {/* The app-wide corner cluster (MapCluster), MIRRORED for the
              seat's bottom-LEFT anchor: the edge column (follow/play
              over the exit verb) hugs the left edge, the TR "compass
              slot" (north reset while the pane is closed, track-up while
              it is open) and globe sit inboard. Empty cells collapse —
              no state leaves buttons floating off the anchor — while TR
              passes null, never undefined, so the compass shares the top
              row instead of floating above it. */}
          <div
            className={cx(mapCss.overlay, seat.overlay)}
            data-testid="map-overlay"
          >
            <MapCluster
              tl={(replay.followButton ?? replay.playButton) || undefined}
              tr={
                replay.trackUpButton ??
                (map && !replay.isOpen ? <CompassButton map={map} /> : null)
              }
              bl={
                <button
                  className={mapCss.button}
                  aria-label={mapFull ? "Shrink map" : "Expand map"}
                  data-testid="map-expand"
                  onClick={() => setMapFull(!mapFull)}
                >
                  <IonIcon icon={mapFull ? contractOutline : expandOutline} />
                </button>
              }
              br={
                map?.supportsSatellite ? (
                  <ViewToggle view={view} onChange={changeView} />
                ) : undefined
              }
            />
          </div>
        </MapCanvas>
        {flight && stats && (
          <div
            className={cx(seat.card, !cardOpen && seat.collapsed)}
            data-testid="seat-card"
          >
            <div
              className={seat.cardHeader}
              onClick={(event) => {
                // The whole title row is the collapse toggle; the buttons
                // in it keep their own jobs.
                if ((event.target as HTMLElement).closest("button")) return;
                setCardOpen(!cardOpen);
              }}
            >
              {/* The WHEN as the header: the name is already the editable
                  field below and the highlighted row in the list. */}
              <div className={seat.cardTitle}>
                {new Date(flight.startedAt).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </div>
              <button
                className={seat.cardCollapse}
                aria-label="Options"
                data-testid="detail-options"
                onClick={openOptions}
              >
                <IonIcon icon={ellipsisHorizontal} />
              </button>
              <button
                className={seat.cardCollapse}
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
                <FlightStats stats={stats} units={units} />
              </>
            )}
          </div>
        )}
      </div>
      {/* The replay pane, sliding open in flow under the seat map. */}
      {replay.drawer}
    </div>
  );
}
