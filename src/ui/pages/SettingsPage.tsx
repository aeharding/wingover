import {
  IonContent,
  IonHeader,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonPage,
  IonSegment,
  IonSegmentButton,
  IonTitle,
  IonToolbar,
} from "@ionic/react";
import { useEffect, useState } from "react";

import { getSetting, setSetting } from "../../storage/db";
import { useSettings } from "../settings/SettingsContext";

export default function SettingsPage() {
  const { units, setUnits } = useSettings();
  const [maptilerKey, setMaptilerKey] = useState("");

  useEffect(() => {
    getSetting("maptilerKey").then((value) => setMaptilerKey(value ?? ""));
  }, []);

  function saveMaptilerKey(value: string) {
    setMaptilerKey(value);
    setSetting("maptilerKey", value);
  }

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Settings</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <IonList>
          <IonItem>
            <IonInput
              label="MapTiler key"
              placeholder="Built-in"
              value={maptilerKey}
              onIonChange={(event) => saveMaptilerKey(event.detail.value ?? "")}
            />
          </IonItem>
          <IonItem>
            <IonLabel>Units</IonLabel>
            <IonSegment
              value={units}
              onIonChange={(event) => {
                const value = event.detail.value;
                if (value === "imperial" || value === "metric") setUnits(value);
              }}
              style={{ maxWidth: "16rem" }}
            >
              <IonSegmentButton value="imperial">Imperial</IonSegmentButton>
              <IonSegmentButton value="metric">Metric</IonSegmentButton>
            </IonSegment>
          </IonItem>
        </IonList>
        <div style={{ textAlign: "center", paddingTop: "2rem" }}>
          <IonNote>Wingover 0.1.0 · AGPL-3.0</IonNote>
        </div>
      </IonContent>
    </IonPage>
  );
}
