import {
  IonContent,
  IonHeader,
  IonPage,
  IonTitle,
  IonToolbar,
} from "@ionic/react";
import { useEffect, useState } from "react";

import { startFlight } from "../../../engine/session";
import { formatDistance } from "../../../flight/format";
import { haversineMeters } from "../../../flight/stats";
import { sunFactLabel } from "../../../flight/sun";
import type { Flight, Pin } from "../../../storage/db";
import { clearLiveViewCamera } from "../../shared/map/liveViewState";
import { useSettings } from "../../shared/settings/SettingsContext";
import { useLiveViewPrefs } from "../../shared/useLiveViewPrefs";
import FlyTrace from "../FlyTrace";
import { useLatestFlight } from "../useLatestFlight";
import { usePlannedPins } from "../usePlannedPins";

import styles from "./FlyPage.module.css";

function greetingForHour(hour: number) {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

// When the greeting above next changes: noon, 18:00, or tomorrow's
// midnight. switch (true) because the arms are ranges, not a discriminant.
function nextBoundaryHour(hour: number) {
  switch (true) {
    case hour < 12:
      return 12;
    case hour < 18:
      return 18;
    default:
      return 24;
  }
}

/**
 * Re-arms a timeout for the next boundary (noon, 6pm, midnight) rather
 * than polling: the page idles mounted for hours and the flight surface
 * below is battery-sensitive. The +1s pad keeps an early-firing timer
 * from landing on the old side of the boundary and never re-arming.
 */
function useGreeting() {
  const [greeting, setGreeting] = useState(() =>
    greetingForHour(new Date().getHours()),
  );

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;

    function schedule() {
      const now = new Date();
      setGreeting(greetingForHour(now.getHours()));
      const next = new Date(now);
      next.setHours(nextBoundaryHour(now.getHours()), 0, 0, 0);
      timer = setTimeout(schedule, next.getTime() - now.getTime() + 1000);
    }

    schedule();
    return () => clearTimeout(timer);
  }, []);

  return greeting;
}

/**
 * The Fly tab: the app's home screen, and a page like PlanPage and
 * SettingsPage — both shells render it whole rather than assembling its parts.
 *
 * Nothing in flight lives here. The moment the engine leaves "idle" the app
 * root sheds this entire shell for src/ui/flight's FlightSurface (App.tsx), so
 * this file only ever shows the pre-flight screen: a couple of quiet facts and
 * one enormous button, over the comet backdrop.
 *
 * Renders only behind the app root's boot gate: pre-hydration the engine
 * reports "idle", and Start Flight below clears the WAL — on an ungated render
 * that destroys a live flight still sitting in it, unread. If the gate ever
 * narrows, this dependency moves with it.
 *
 * Idle facts are all derived offline (tiles stay the app's entire network
 * surface). The sun fact needs a location: the last flight's launch, else the
 * first planned pin — where they last flew or where they're planning is where a
 * pilot flies next. No location, no line.
 *
 * fullscreen + scrollY={false}: fullscreen lets the content box reach UNDER the
 * translucent tab bar (the ionic-framework#28246 mechanism); scrollY off
 * because this screen never scrolls (e2e-guarded). FlyTrace is the content's
 * actual background — a backdrop canvas spanning that full box, so the comet
 * flies under the bar.
 */
export default function FlyPage() {
  const greeting = useGreeting();
  const { units } = useSettings();
  const plannedPins = usePlannedPins();
  // The newest logbook flight feeds the idle facts (the sun fact needs a
  // location; its launch point is the best guess for the next one).
  const lastFlight = useLatestFlight();
  const liveView = useLiveViewPrefs();

  // The sun fact is relative time through most of the cycle; re-render by the
  // minute while this screen is up so it cannot go stale on a propped phone.
  useMinuteTick();

  const sunFact = sunFactFor(lastFlight, plannedPins);
  const plannedRouteMeters = routeMeters(plannedPins);
  const hasPlannedRoute = plannedRouteMeters > 0;

  async function startNewFlight() {
    // Arming resets the live view to the flight's default: snapped to the
    // aircraft, north-up, at the default zoom. (Unsnapping later takes
    // track-up down with it — see RecordingSurface's changeFollow.) Written
    // through before the status flips, because FlightSurface reads it back on
    // mount. Arming is the ONLY path here: a mid-flight reload or heal goes
    // straight to the flight surface (App.tsx), so it keeps the camera.
    liveView.update({ follow: true });
    liveView.update({ trackUp: false });
    clearLiveViewCamera();
    await startFlight();
  }

  return (
    <IonPage className={styles.frame}>
      {/* The large-title pattern, same as SettingsPage: a main header (its
          title shows condensed on scroll) paired with the condense header in
          the content (the big title). Both toolbars are transparent and
          pointer-inert (FlyPage.module.css) so the title floats over the sky. */}
      <IonHeader>
        <IonToolbar>
          <IonTitle>{greeting}</IonTitle>
        </IonToolbar>
      </IonHeader>
      {/* fixedSlotPlacement="before": the fixed slot (the splash) renders
          BEFORE the scroll content in the shadow DOM, so the backdrop paints
          behind the screen, not over it. */}
      <IonContent fullscreen scrollY={false} fixedSlotPlacement="before">
        <FlyTrace />
        <IonHeader collapse="condense">
          <IonToolbar>
            <IonTitle size="large">{greeting}</IonTitle>
          </IonToolbar>
        </IonHeader>
        <div className={styles.content} data-testid="fly-content">
          <div className={styles.facts} data-testid="idle-facts">
            {sunFact && <div>{sunFact}</div>}
            {hasPlannedRoute && (
              <div data-testid="planned-route">
                Planned route: {formatDistance(plannedRouteMeters, units)}
              </div>
            )}
          </div>
          <button
            className={styles.start}
            onClick={() => void startNewFlight()}
          >
            Start Flight
          </button>
        </div>
      </IonContent>
    </IonPage>
  );
}

function sunFactFor(lastFlight: Flight | null, plannedPins: Pin[]) {
  const launch = lastFlight?.launchAt;
  if (launch) return sunFactLabel(new Date(), launch[1], launch[0]);
  const pin = plannedPins[0];
  if (!pin) return null;
  return sunFactLabel(new Date(), pin.latitude, pin.longitude);
}

/** Total planned-route length = sum of the legs between consecutive pins. */
function routeMeters(pins: Pin[]): number {
  let total = 0;
  for (let i = 1; i < pins.length; i++) {
    total += haversineMeters(pins[i - 1], pins[i]);
  }
  return total;
}

// A render heartbeat for the relative sun fact, only while it shows.
function useMinuteTick() {
  const [, bump] = useState(0);
  useEffect(() => {
    const id = setInterval(() => bump((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);
}
