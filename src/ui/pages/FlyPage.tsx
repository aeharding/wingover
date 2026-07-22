import { IonContent, IonPage } from "@ionic/react";

import FlyPage from "../flight/FlyPage";

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
 * fullscreen + scrollY={false}: fullscreen lets the surface paint UNDER
 * the translucent tab bar (the ionic-framework#28246 mechanism), so the
 * idle splash flows into it; scrollY off because the flight surface never
 * scrolls (its own overflow: hidden is e2e-guarded).
 */
export default function FlyPageFramed() {
  return (
    <IonPage className="fly-page-frame">
      <IonContent fullscreen scrollY={false}>
        <FlyPage />
      </IonContent>
    </IonPage>
  );
}
