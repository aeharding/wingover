import {
  IonAlert,
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

import { isTauri } from "../../engine/platform";
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
  const [recordHere, setRecordHere] = useState(false);
  const [confirmRecordHere, setConfirmRecordHere] = useState(false);
  // Bumped when the warning alert is dismissed: ion-toggle keeps its own
  // internal checked state, so a cancelled enable leaves it visually ON
  // (and the next tap a silent no-op) unless the element is remounted.
  const [toggleReset, setToggleReset] = useState(0);

  // Re-read on every entry, not once on mount: the provider subpage edits
  // the same settings, and this page stays mounted behind it.
  useIonViewWillEnter(() => {
    getSetting("mapBackend").then((value) => {
      if (value === "mapkit" || value === "maplibre") setMapBackend(value);
    });
    getBooleanSetting("autoEndFlight", true).then(setAutoEnd);
    getBooleanSetting("recordInBrowser", false).then(setRecordHere);
  }, []);

  function saveAutoEnd(value: boolean) {
    setAutoEnd(value);
    void setBooleanSetting("autoEndFlight", value);
  }

  function saveRecordHere(value: boolean) {
    setRecordHere(value);
    void setBooleanSetting("recordInBrowser", value);
    // Mirrored synchronously for boot: the "/" redirect and the /fly route
    // gate commit on first render, long before an IndexedDB read resolves.
    // PouchDB stays the source of truth; this is a cache of it.
    try {
      if (value) localStorage.setItem("wingover.record", "1");
      else localStorage.removeItem("wingover.record");
    } catch {
      // No storage, no mirror; the async setting still applies in-session.
    }
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
          {!isTauri() && (
            <IonItem>
              <IonToggle
                key={`record-${toggleReset}-${recordHere}`}
                checked={recordHere}
                onIonChange={(event) => {
                  if (event.detail.checked) setConfirmRecordHere(true);
                  else saveRecordHere(false);
                }}
              >
                Record in this browser
              </IonToggle>
            </IonItem>
          )}
        </IonList>
        {!isTauri() && (
          <div className="settings-helper-text">
            Browsers can stop background recording at any time. Your phone
            running the Wingover app is the recorder to trust.
          </div>
        )}
        <IonAlert
          isOpen={confirmRecordHere}
          onDidDismiss={() => {
            setConfirmRecordHere(false);
            // Snap the toggle back to reality however the alert closed
            // (confirm changes recordHere, which changes the key anyway).
            setToggleReset((n) => n + 1);
          }}
          header="Record in this browser?"
          message="Browsers can stop background recording at any time, and a stopped recording ends the flight. Use this only when the phone app is not an option."
          buttons={[
            { text: "Cancel", role: "cancel" },
            {
              text: "Turn on",
              handler: () => saveRecordHere(true),
            },
          ]}
        />

        <div style={{ textAlign: "center", paddingTop: "2rem" }}>
          <IonNote>Wingover 0.1.0 · AGPL-3.0</IonNote>
        </div>
      </IonContent>
    </IonPage>
  );
}
