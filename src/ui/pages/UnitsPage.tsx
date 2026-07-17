import {
  IonBackButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonItem,
  IonList,
  IonPage,
  IonRadio,
  IonRadioGroup,
  IonTitle,
  IonToolbar,
} from "@ionic/react";

import { useSettings } from "../settings/SettingsContext";

import "./SettingsPage.css";

/**
 * Apple's Settings idiom for pick-one: the row pushes a page whose options
 * are a checkmark list (ion-radio renders as a trailing checkmark in iOS
 * mode). Selection applies immediately; back is the only exit.
 */
export default function UnitsPage() {
  const { units, setUnits } = useSettings();

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <IonBackButton defaultHref="/settings" text="Settings" />
          </IonButtons>
          <IonTitle>Units</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent className="settings-content">
        <IonList inset>
          <IonRadioGroup
            value={units}
            onIonChange={(event) => {
              const value = event.detail.value;
              if (value === "imperial" || value === "metric") setUnits(value);
            }}
          >
            <IonItem>
              <IonRadio value="imperial">Imperial</IonRadio>
            </IonItem>
            <IonItem>
              <IonRadio value="metric">Metric</IonRadio>
            </IonItem>
          </IonRadioGroup>
        </IonList>
      </IonContent>
    </IonPage>
  );
}
