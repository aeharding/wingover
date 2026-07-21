import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonList,
  IonPage,
  IonRadio,
  IonRadioGroup,
  IonTitle,
  IonToolbar,
} from "@ionic/react";
import { chevronBackOutline } from "ionicons/icons";
import { useHistory } from "react-router-dom";

import { useSettings } from "../settings/SettingsContext";
import { useIsDesktop } from "../useIsDesktop";

import "./SettingsPage.css";

/**
 * Apple's Settings idiom for pick-one: the row pushes a page whose options
 * are a checkmark list (ion-radio renders as a trailing checkmark in iOS
 * mode). Selection applies immediately; back is the only exit.
 */
export default function UnitsPage() {
  const history = useHistory();
  const isDesktop = useIsDesktop();
  const { units, setUnits } = useSettings();

  return (
    <IonPage className="settings-page">
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            {isDesktop ? (
              <IonButton onClick={() => history.push("/settings")}>
                <IonIcon slot="start" icon={chevronBackOutline} />
                Settings
              </IonButton>
            ) : (
              <IonBackButton defaultHref="/settings" text="Settings" />
            )}
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
