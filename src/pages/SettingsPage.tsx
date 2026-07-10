import {
  IonContent,
  IonHeader,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonNote,
  IonPage,
  IonSegment,
  IonSegmentButton,
  IonTitle,
  IonToolbar,
} from "@ionic/react";
import { useEffect, useState } from "react";

import { useSettings } from "../settings/SettingsContext";
import { getSetting, setSetting } from "../storage/db";

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
        <IonList>
          <IonListHeader>
            <IonLabel>Map data</IonLabel>
          </IonListHeader>
          <IonItem
            href="https://www.openstreetmap.org/copyright"
            target="_blank"
            rel="noopener"
            detail
            data-testid="osm-attribution"
          >
            <IonLabel>
              <h3>© OpenStreetMap contributors</h3>
              <p>Map data available under the Open Database License</p>
            </IonLabel>
          </IonItem>
          <IonItem
            href="https://openfreemap.org"
            target="_blank"
            rel="noopener"
            detail
          >
            <IonLabel>
              <h3>OpenFreeMap</h3>
              <p>Street map tiles</p>
            </IonLabel>
          </IonItem>
          <IonItem
            href="https://www.maptiler.com/copyright/"
            target="_blank"
            rel="noopener"
            detail
          >
            <IonLabel>
              <h3>© MapTiler</h3>
              <p>Satellite imagery</p>
            </IonLabel>
          </IonItem>
        </IonList>
        <div style={{ textAlign: "center", paddingTop: "2rem" }}>
          <IonNote>Wingover 0.0.0 · AGPL-3.0</IonNote>
        </div>
      </IonContent>
    </IonPage>
  );
}
