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
} from "@ionic/react";
import {
  contractOutline,
  ellipsisHorizontal,
  expandOutline,
} from "ionicons/icons";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal, flushSync } from "react-dom";
import {
  createHtmlPortalNode,
  InPortal,
  OutPortal,
} from "react-reverse-portal";
import { useParams } from "react-router";

import { isTauri } from "../../engine/platform";
import {
  formatAirtime,
  formatAltitude,
  formatDistance,
  formatSpeed,
} from "../../flight/format";
import { getSetting, setSetting } from "../../storage/local";
import { useFlightDoc } from "../logbook/useFlightDoc";
import { useFlightDrafts } from "../logbook/useFlightDrafts";
import { afterNextFrame } from "../map/afterFrame";
import CompassButton from "../map/CompassButton";
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

// The expand/collapse toggle animates as a "magic move": the map surface
// carries a view-transition-name (FlightDetailPage.css), so
// startViewTransition morphs its box between the inline frame and the
// overlay. flushSync makes React commit inside the transition callback,
// where the API needs the new DOM. Progressive: engines without the API
// (< iOS 18) jump-cut, and reduced-motion users keep the cut on purpose.
// Also deliberately NOT animated: every path that crosses a real
// browser-fullscreen boundary (grant landing mid-expand, exitFullscreen
// collapse, Esc) — a viewport resize aborts an active view transition per
// spec, and animating across one would be jank anyway. On Tauri (no
// Fullscreen API) every toggle animates.
function withMapTransition(update: () => void) {
  if (
    !document.startViewTransition ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    update();
    return;
  }
  document.startViewTransition(() => {
    flushSync(update);
  });
}

// PWA under real browser fullscreen: leave fullscreen FIRST and let the
// page's fullscreenchange handler fold the map once the exit lands.
// Elsewhere (Tauri, no Fullscreen API, grant denied) fold immediately.
// Module-scoped over the setter so effects can call it with honest deps.
function collapseMapVia(setMapFull: (value: boolean) => void) {
  if (document.fullscreenElement) {
    void document.exitFullscreen().catch(() => setMapFull(false));
  } else {
    withMapTransition(() => setMapFull(false));
  }
}

/**
 * The PHONE flight page: map on top, details scrolling below. Desktop
 * renders the logbook split instead (DesktopShell → LogbookSection →
 * FlightSeat); this page only ever mounts inside the Ionic tab shell.
 */
export default function FlightDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useIonRouter();
  const { units } = useSettings();
  const { exportFlight, confirmDeleteFlight } = useFlightActions();
  const { flight, setFlight, track } = useFlightDoc(id);
  const { drafts, setDraft, commit } = useFlightDrafts(
    flight,
    setFlight,
    track,
  );
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [view, setView] = useState<MapViewKind>("street");
  const [map, setMap] = useState<MapView | null>(null);
  const [mapFull, setMapFull] = useState(false);
  // Mirrors mapFull for the async fullscreen grant below: two quick taps
  // can fold the map before the browser grants fullscreen, and the grant
  // callback must see the CURRENT intent, not the one it closed over.
  const mapFullRef = useRef(false);
  const contentRef = useRef<HTMLIonContentElement>(null);
  // The map surface lives in this portal so full screen can REPARENT it (same
  // React and DOM instance — no map re-init) between the inline frame and a
  // fixed overlay on document.body. Lazy useState = create-once (this is
  // instantiation, not memoization — not a job for the compiler).
  const [mapPortal] = useState(() =>
    createHtmlPortalNode({
      attributes: { style: "position:absolute;inset:0" },
    }),
  );
  const lineRef = useRef<Line | null>(null);
  const planLineRef = useRef<Line | null>(null);
  const markersRef = useRef<MarkerLayer | null>(null);

  useEffect(() => {
    getSetting("mapView").then((value) => {
      if (value === "street" || value === "satellite") setView(value);
    });
  }, [id]);

  function changeView(value: MapViewKind) {
    setView(value);
    setSetting("mapView", value);
  }

  // Full screen REPARENTS the map surface (same instance — reverse portal, no
  // remount) into a fixed overlay on document.body. Outside the scroller,
  // nothing about the details layout or scroll position ever changes: no
  // save/restore, no clamp races, and drags on the overlay can't reach the
  // page scroller (its scrollable ancestors are body/html). Bonus guard: a
  // status-bar tap's center hit-test finds no ion-content above the overlay,
  // so Ionic's statusTap scroll-to-top is a natural no-op while fullscreen.
  //
  function expandMap() {
    // With the keyboard up, a tap on the map means "get me out of this
    // field" — dismiss and stay put. Expanding under a closing keyboard
    // looks broken and yanks the pilot out of an edit. (keyboard-open is
    // native-only; on the PWA the tap expands as usual.)
    if (document.documentElement.classList.contains("keyboard-open")) {
      (document.activeElement as HTMLElement | null)?.blur();
      return;
    }
    withMapTransition(() => setMapFull(true));
  }

  const collapseMap = () => collapseMapVia(setMapFull);

  // Native only: the keyboard's return key reads "Done" (enterkeyhint on the
  // inputs below) and pressing it closes the keyboard. Single-line fields have
  // nothing else for Enter to do, and the accessory bar with its own Done is
  // hidden globally. On the PWA, Enter keeps the browser's default behavior.
  function blurOnEnter(event: ReactKeyboardEvent<HTMLIonInputElement>) {
    if (!isTauri() || event.key !== "Enter") return;
    // A CJK keyboard's Return first commits the composition — that keystroke
    // must not steal the keyboard mid-word.
    if (event.nativeEvent.isComposing) return;
    (document.activeElement as HTMLElement | null)?.blur();
  }

  // Native only: ease a focused field into view above the keyboard. (Ionic's
  // scroll assist is switched off under Tauri — see App.tsx — so this is the
  // only scroller; with the map as a scroll-through preview a field can sit
  // low or behind the keyboard. On the PWA the webview doesn't resize for the
  // keyboard and Ionic's assist owns the job, so this would fight it.)
  useEffect(() => {
    if (!isTauri()) return;
    const content = contentRef.current;
    if (!content) return;
    let timer = 0;
    const onFocusIn = (event: FocusEvent) => {
      const field = (event.target as HTMLElement | null)?.closest(
        "ion-input, ion-textarea",
      );
      if (!field) return;
      // Let the keyboard open and <ion-app> resize first, then center the field
      // in the space that's left. The timer is cleared on refocus/unmount so a
      // field blurred within the window isn't pointlessly centered.
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        field.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 300);
    };
    content.addEventListener("focusin", onFocusIn);
    return () => {
      window.clearTimeout(timer);
      content.removeEventListener("focusin", onFocusIn);
    };
  }, []);

  // Full screen means NO bars — the body-level overlay simply COVERS the
  // header and tab bar (their layout never changes, so neither does the
  // scroller's). On the PWA the Fullscreen API sheds the browser chrome too;
  // it reverses in the cleanup, so navigating away while expanded can't
  // strand a fullscreened document.
  useLayoutEffect(() => {
    mapFullRef.current = mapFull;
    if (!mapFull) return;
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
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      if (document.fullscreenElement) {
        void document.exitFullscreen().catch(() => {});
      }
    };
  }, [mapFull]);

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

  // Fit the flown track and the planned pins together, so a plan that
  // overshoots the track (unreached waypoints) still frames fully. Extra
  // bottom padding keeps the track clear of the view toggle.
  const frameFlight = useEffectEvent((animate: boolean) => {
    if (!map || track.length === 0) return;
    const bounds = boundsOf([
      ...track.map((fix): LngLat => [fix.longitude, fix.latitude]),
      ...(flight?.plannedRoute ?? []).map((coord): LngLat => [
        coord[0],
        coord[1],
      ]),
    ]);
    if (bounds) {
      map.fitBounds(bounds, {
        padding: { top: 40, bottom: 76, left: 40, right: 40 },
        animate,
      });
    }
  });

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

    frameFlight(false);
  }, [track, map, flight?.id, flight?.plannedRoute]);

  // Leaving full screen EASES the map back to the framed flight: wherever
  // the pilot panned, zoomed, or rotated while exploring, the inline
  // preview returns showing the flight (a bounds fit is north-up by
  // construction, so this also re-norths and dismisses the compass).
  const wasFullRef = useRef(false);
  useEffect(() => {
    const was = wasFullRef.current;
    wasFullRef.current = mapFull;
    if (!(was && !mapFull)) return;
    // Collapse just resized the map's container; frame only after the
    // backend has adopted the new size (see afterNextFrame) or the fit
    // computes bounds against the fullscreen dimensions.
    return afterNextFrame(() => frameFlight(true));
  }, [mapFull]);

  const stats = flight?.stats;

  return (
    <IonPage>
      {/* Always mounted; the fullscreen overlay simply covers it (never
          conditionally render it — a remounting Stencil ion-header sizes
          async, and the late layout clamps the scroll position). */}
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <IonBackButton defaultHref="/logbook" />
          </IonButtons>
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
      {/* scrollY stays on even full screen: the map overlay covers the details
          and eats the touches, so nothing scrolls behind it anyway, and toggling
          overflow off/on is what was resetting the scroll position on collapse. */}
      <IonContent ref={contentRef}>
        {/* Map and details split the screen instead of a card floating over
            the track — nothing overlaps the flight, and the stats get room
            to breathe below. The frame only reserves the space; the map
            surface itself lives in mapPortal and is reparented here (inline)
            or into the body-level overlay below (full screen). */}
        <div className="flight-detail-map-frame">
          {!mapFull && <OutPortal node={mapPortal} />}
        </div>
        {flight && stats && (
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
                  enterkeyhint="done"
                  onKeyDown={blurOnEnter}
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
                  enterkeyhint="done"
                  onKeyDown={blurOnEnter}
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
                  value={drafts.notes}
                  aria-label="Flight notes"
                  onIonInput={(event) =>
                    setDraft("notes", event.detail.value ?? "")
                  }
                  onIonBlur={commit}
                />
              </IonItem>
            </IonList>
            <IonList>
              <Stat
                label="Duration"
                value={formatAirtime(stats.durationSeconds)}
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
      {/* The one true map surface. Full screen: a single tap on the map
          collapses it — via the map's own singletap gesture (MapKit's
          single-tap / a debounced MapLibre click), which never fires for
          pans, pinches, double-tap zooms, or taps on annotations and
          controls. Inline, the map-tap-layer owns tap-to-expand. */}
      <InPortal node={mapPortal}>
        <div className={`flight-detail-map${mapFull ? " map-full" : ""}`}>
          {/* Edge-to-edge only when expanded to full screen (bottom under the
              home indicator); embedded in the split, it isn't. */}
          <MapCanvas base={view} onReady={handleReady} edgeToEdge={mapFull} />
          {/* Inline the map is a scroll-through preview: tap anywhere to
              expand, vertical drag scrolls the details through (see
              FlightDetailPage.css). */}
          {!mapFull && <div className="map-tap-layer" onClick={expandMap} />}
          <div className="map-overlay">
            {map && <CompassButton map={map} />}
            {mapFull && (
              <button
                className="map-button"
                aria-label="Shrink map"
                data-testid="map-shrink"
                onClick={collapseMap}
              >
                <IonIcon icon={contractOutline} />
              </button>
            )}
            {map?.supportsSatellite && (
              <ViewToggle view={view} onChange={changeView} />
            )}
          </div>
          {/* A visible affordance for the tap-to-expand above. */}
          {!mapFull && (
            <button
              className="map-expand-pill"
              aria-label="Expand map"
              data-testid="map-expand"
              onClick={expandMap}
            >
              <IonIcon icon={expandOutline} />
              Expand
            </button>
          )}
        </div>
      </InPortal>
      {/* Full screen: a fixed overlay on document.body — OUTSIDE the page
          scroller (so scroll position and layout are untouched by
          construction, and drags on the overlay have nothing scrollable to
          grab) and outside ion-content (so a status-bar tap's center
          hit-test finds nothing to scroll). It covers the header and tab
          bar rather than hiding them. */}
      {mapFull &&
        createPortal(
          <div className="flight-detail-map-fullroot">
            <OutPortal node={mapPortal} />
          </div>,
          document.body,
        )}
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
