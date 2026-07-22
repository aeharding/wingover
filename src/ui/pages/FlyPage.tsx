import {
  IonContent,
  IonHeader,
  IonPage,
  IonTitle,
  IonToolbar,
} from "@ionic/react";

import FlyPage from "../flight/FlyPage";
import FlySplash from "../flight/FlySplash";

/**
 * The Ionic frame around the Ionic-free flight surface. The phone's
 * router outlet needs an ion-page element to run transitions against;
 * the flight folder itself never imports Ionic (enforced by lint), so
 * the frame lives out here in Ionic land. The desktop shell renders
 * src/ui/flight/FlyPage directly, frameless.
 *
 * .fly-page-frame (theme.css) pins the frame black in both schemes: the
 * flight surface is exempt from theming.
 *
 * fullscreen + scrollY={false}: fullscreen lets the content box reach
 * UNDER the translucent tab bar (the ionic-framework#28246 mechanism);
 * scrollY off because the flight surface never scrolls (its own
 * overflow: hidden is e2e-guarded). FlySplash is the content's actual
 * background — a backdrop element spanning that full box, so the idle
 * artwork flows into the bar; the surface renders transparent over it
 * when idle and covers it in flight.
 */
export default function FlyPageFramed() {
  return (
    <IonPage className="fly-page-frame">
      {/* The large-title pattern, same as SettingsPage: a main header
          (its title shows condensed on scroll) paired with the condense
          header in the content (the big title). Both toolbars are
          transparent and pointer-inert (FlyPage.css) so the title floats
          over the sky. The armed/recording states cover it for free —
          the surface below paints opaque over the whole content box in
          flight — and the whole Ionic shell is shed then anyway. */}
      <IonHeader translucent>
        <IonToolbar>
          <IonTitle>Wingover</IonTitle>
        </IonToolbar>
      </IonHeader>
      {/* fixedSlotPlacement="before": the fixed slot (the splash) renders
          BEFORE the scroll content in the shadow DOM, so the backdrop
          paints behind the surface, not over it. */}
      <IonContent fullscreen scrollY={false} fixedSlotPlacement="before">
        <FlySplash />
        <IonHeader collapse="condense">
          <IonToolbar>
            <IonTitle size="large">Wingover</IonTitle>
          </IonToolbar>
        </IonHeader>
        <FlyPage />
      </IonContent>
    </IonPage>
  );
}
