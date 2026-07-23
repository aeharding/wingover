import {
  IonContent,
  IonHeader,
  IonPage,
  IonTitle,
  IonToolbar,
} from "@ionic/react";
import { useEffect, useState } from "react";

import FlyPage from "../flight/FlyPage";
import FlyTrace from "../flight/FlyTrace";

import styles from "./FlyFrame.module.css";

function greetingForHour(hour: number) {
  if (hour < 12) return "Good Morning";
  if (hour < 18) return "Good Afternoon";
  return "Good Evening";
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
    let timer: number;

    function arm() {
      const now = new Date();
      const boundary = new Date(now);
      const hour = now.getHours();
      boundary.setHours(hour < 12 ? 12 : hour < 18 ? 18 : 24, 0, 0, 0);

      timer = window.setTimeout(
        () => {
          setGreeting(greetingForHour(new Date().getHours()));
          arm();
        },
        boundary.getTime() - now.getTime() + 1000,
      );
    }

    arm();
    return () => clearTimeout(timer);
  }, []);

  return greeting;
}

/**
 * The Ionic frame around the Ionic-free flight surface. The phone's
 * router outlet needs an ion-page element to run transitions against;
 * the flight folder itself never imports Ionic (enforced by lint), so
 * the frame lives out here in Ionic land. The desktop shell renders
 * src/ui/flight/FlyPage directly, frameless.
 *
 * .frame (FlyFrame.module.css) pins the frame black in the DARK scheme
 * only; the idle page themes with the app (FlyTrace has a light-mode
 * ink design). Armed and recording paint their own black over either.
 *
 * fullscreen + scrollY={false}: fullscreen lets the content box reach
 * UNDER the translucent tab bar (the ionic-framework#28246 mechanism);
 * scrollY off because the flight surface never scrolls (its own
 * overflow: hidden is e2e-guarded). FlyTrace is the content's actual
 * background — a backdrop canvas spanning that full box, so the comet
 * flies under the bar; the surface renders transparent over it when
 * idle and covers it in flight.
 */
export default function FlyFrame() {
  const greeting = useGreeting();

  return (
    <IonPage className={styles.frame}>
      {/* The large-title pattern, same as SettingsPage: a main header
          (its title shows condensed on scroll) paired with the condense
          header in the content (the big title). Both toolbars are
          transparent and pointer-inert (FlyFrame.module.css) so the title floats
          over the sky. The armed/recording states cover it for free —
          the surface below paints opaque over the whole content box in
          flight — and the whole Ionic shell is shed then anyway. */}
      <IonHeader>
        <IonToolbar>
          <IonTitle>{greeting}</IonTitle>
        </IonToolbar>
      </IonHeader>
      {/* fixedSlotPlacement="before": the fixed slot (the splash) renders
          BEFORE the scroll content in the shadow DOM, so the backdrop
          paints behind the surface, not over it. */}
      <IonContent fullscreen scrollY={false} fixedSlotPlacement="before">
        <FlyTrace />
        <IonHeader collapse="condense">
          <IonToolbar>
            <IonTitle size="large">{greeting}</IonTitle>
          </IonToolbar>
        </IonHeader>
        <FlyPage />
      </IonContent>
    </IonPage>
  );
}
