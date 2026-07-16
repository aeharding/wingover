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
  IonToggle,
  IonToolbar,
} from "@ionic/react";
import { useEffect, useState, useSyncExternalStore } from "react";

import {
  getBooleanSetting,
  getSetting,
  setBooleanSetting,
  setSetting,
} from "../../storage/local";
import * as sync from "../../sync";
import { useSettings } from "../settings/SettingsContext";
import { describe as describeSync } from "../sync/describe";
import { useSyncSheet } from "../sync/SyncSheets";

export default function SettingsPage() {
  const { units, setUnits } = useSettings();
  const openSync = useSyncSheet();
  const syncStatus = useSyncExternalStore(sync.subscribe, sync.currentStatus);

  // One row, one question: are the flights backed up? Off is never a neutral
  // dash — it means the flights live only on this phone, and that gets said,
  // in red. Everything subscription-shaped lives inside the sheet.
  const syncNote =
    syncStatus.state === "off"
      ? "Local Only"
      : describeSync(syncStatus).label;
  const [maptilerKey, setMaptilerKey] = useState("");
  const [autoEnd, setAutoEnd] = useState(true);

  useEffect(() => {
    getSetting("maptilerKey").then((value) => setMaptilerKey(value ?? ""));
    getBooleanSetting("autoEndFlight", true).then(setAutoEnd);
  }, []);

  function saveAutoEnd(value: boolean) {
    setAutoEnd(value);
    void setBooleanSetting("autoEndFlight", value);
  }

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
          <IonItem button detail onClick={openSync} data-testid="settings-sync">
            <IonLabel>Sync</IonLabel>
            <IonNote
              slot="end"
              color={syncNote === "Local Only" ? "danger" : undefined}
            >
              {syncNote}
            </IonNote>
          </IonItem>
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
          <IonItem>
            <IonToggle
              checked={autoEnd}
              onIonChange={(event) => saveAutoEnd(event.detail.checked)}
            >
              Auto-end flight after landing
            </IonToggle>
          </IonItem>
        </IonList>
        <div style={{ textAlign: "center", paddingTop: "2rem" }}>
          <IonNote>Wingover 0.1.0 · AGPL-3.0</IonNote>
        </div>
      </IonContent>
    </IonPage>
  );
}
