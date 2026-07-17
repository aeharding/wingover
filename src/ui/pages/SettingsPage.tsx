import {
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonPage,
  IonTitle,
  IonToggle,
  IonToolbar,
  useIonViewWillEnter,
} from "@ionic/react";
import { checkmarkOutline, closeCircle } from "ionicons/icons";
import { useState, useSyncExternalStore } from "react";

import {
  getBooleanSetting,
  getSetting,
  setBooleanSetting,
} from "../../storage/local";
import * as sync from "../../sync";
import { useSettings } from "../settings/SettingsContext";
import { describe as describeSync } from "../sync/describe";
import { useSyncSheet } from "../sync/SyncSheets";

import "./SettingsPage.css";

export default function SettingsPage() {
  const { units } = useSettings();
  const openSync = useSyncSheet();
  const syncStatus = useSyncExternalStore(sync.subscribe, sync.currentStatus);

  // One row, one question: are the flights backed up? Off is never a neutral
  // dash — it reads as red "⊗ Off": flights live only on this phone.
  // Everything subscription-shaped lives inside the sheet.
  const off = syncStatus.state === "off";
  const syncNote = off ? "Off" : describeSync(syncStatus).label;
  const [mapBackend, setMapBackend] = useState("mapkit");
  const [autoEnd, setAutoEnd] = useState(true);

  // Re-read on every entry, not once on mount: the provider subpage edits
  // the same settings, and this page stays mounted behind it.
  useIonViewWillEnter(() => {
    getSetting("mapBackend").then((value) => {
      if (value === "mapkit" || value === "maplibre") setMapBackend(value);
    });
    getBooleanSetting("autoEndFlight", true).then(setAutoEnd);
  }, []);

  function saveAutoEnd(value: boolean) {
    setAutoEnd(value);
    void setBooleanSetting("autoEndFlight", value);
  }

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Settings</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent className="settings-content">
        <IonList inset>
          <IonItem button detail onClick={openSync} data-testid="settings-sync">
            <IonLabel>Sync</IonLabel>
            <IonNote
              slot="end"
              className={`settings-sync-note ${
                off
                  ? "settings-sync-off"
                  : syncNote === "On"
                    ? "settings-sync-on"
                    : ""
              }`}
            >
              {off && <IonIcon icon={closeCircle} aria-hidden="true" />}
              {!off && syncNote === "On" && (
                <IonIcon icon={checkmarkOutline} aria-hidden="true" />
              )}
              {syncNote}
            </IonNote>
          </IonItem>
        </IonList>

        <div className="settings-list-header">Recording</div>
        <IonList inset>
          <IonItem>
            <IonToggle
              checked={autoEnd}
              onIonChange={(event) => saveAutoEnd(event.detail.checked)}
            >
              Auto-end flight after landing
            </IonToggle>
          </IonItem>
        </IonList>

        <div className="settings-list-header">General</div>
        <IonList inset>
          <IonItem button detail routerLink="/settings/units">
            <IonLabel>Units</IonLabel>
            <IonNote slot="end">
              {units === "metric" ? "Metric" : "Imperial"}
            </IonNote>
          </IonItem>
        </IonList>

        <div className="settings-list-header">Advanced</div>
        <IonList inset>
          {/* Apple's pick-one idiom: the row shows the current value and
              pushes a checkmark list. */}
          <IonItem button detail routerLink="/settings/map">
            <IonLabel>Map Provider</IonLabel>
            <IonNote slot="end">
              {mapBackend === "maplibre" ? "MapLibre" : "MapKit"}
            </IonNote>
          </IonItem>
        </IonList>

        <div style={{ textAlign: "center", paddingTop: "2rem" }}>
          <IonNote>Wingover 0.1.0 · AGPL-3.0</IonNote>
        </div>
      </IonContent>
    </IonPage>
  );
}
