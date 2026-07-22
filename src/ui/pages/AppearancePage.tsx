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

import settings from "./settings.module.css";

/**
 * Appearance, pilot-chosen (Apple checkmark-list idiom, see UnitsPage). Dark
 * is the default and keeps the whole app dark; Auto follows the device scheme
 * (and satellite view still forces dark). Selection applies immediately and
 * live — the palette re-derives with no reload.
 */
export default function AppearancePage() {
  const history = useHistory();
  const isDesktop = useIsDesktop();
  const { appearance, setAppearance } = useSettings();

  return (
    <IonPage className={settings.page}>
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
          <IonTitle>Appearance</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent className={settings.content}>
        <IonList inset>
          <IonRadioGroup
            value={appearance}
            onIonChange={(event) => {
              const value = event.detail.value;
              if (value === "dark" || value === "auto") setAppearance(value);
            }}
          >
            <IonItem>
              <IonRadio value="dark">Dark</IonRadio>
            </IonItem>
            <IonItem>
              <IonRadio value="auto">Auto</IonRadio>
            </IonItem>
          </IonRadioGroup>
        </IonList>
        <div className={settings.helperText}>
          Auto follows your device between light and dark.
        </div>
      </IonContent>
    </IonPage>
  );
}
