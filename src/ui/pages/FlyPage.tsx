import { IonPage } from "@ionic/react";

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
 */
export default function FlyPageFramed() {
  return (
    <IonPage className="fly-page-frame">
      <FlyPage />
    </IonPage>
  );
}
