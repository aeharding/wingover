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
  IonSpinner,
  IonTitle,
  IonToggle,
  IonToolbar,
  useIonViewWillEnter,
} from "@ionic/react";
import { checkmarkOutline, closeCircle } from "ionicons/icons";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useHistory } from "react-router-dom";

import { isTauri } from "../../engine/platform";
import {
  getBooleanSetting,
  getSetting,
  setBooleanSetting,
} from "../../storage/local";
import * as sync from "../../sync";
import { cx } from "../cx";
import { useSettings } from "../settings/SettingsContext";
import { describe as describeSync, type SyncTone } from "../sync/describe";
import { useSyncSheet } from "../sync/SyncSheets";
import { useCanRecord } from "../useCanRecord";
import { useIsDesktop } from "../useIsDesktop";

import settings from "./settings.module.css";
import styles from "./SettingsPage.module.css";

// Semantic tone → the Settings row's note color. Off red, On green, a lapse
// amber, a problem red; transient states neutral. One map (shared derivation in
// describe), so the row can never disagree with the sheet or rail on a status.
const SETTINGS_TONE_CLASS: Record<SyncTone, string> = {
  on: styles.on,
  off: styles.off,
  warn: styles.warn,
  error: styles.error,
  neutral: "",
};

export default function SettingsPage() {
  const { units, appearance } = useSettings();
  const openSync = useSyncSheet();
  const history = useHistory();
  const canRecord = useCanRecord();
  const isDesktop = useIsDesktop();
  const syncStatus = useSyncExternalStore(sync.subscribe, sync.currentStatus);

  // One row, one question: are the flights backed up? Off is never a neutral
  // dash — it reads as red "⊗ Off": flights live only on this phone.
  // Everything subscription-shaped lives inside the sheet.
  const off = syncStatus.state === "off";
  const described = describeSync(syncStatus);
  const syncNote = described.label;
  const syncBusy =
    syncStatus.state === "connecting" ||
    (syncStatus.state === "syncing" && syncStatus.active);
  const [mapBackend, setMapBackend] = useState("mapkit");
  const [autoEnd, setAutoEnd] = useState(true);
  const [recordHere, setRecordHere] = useState(false);
  const [confirmRecordHere, setConfirmRecordHere] = useState(false);
  // Bumped when the warning alert is dismissed: ion-toggle keeps its own
  // internal checked state, so a cancelled enable leaves it visually ON
  // (and the next tap a silent no-op) unless the element is remounted.
  const [toggleReset, setToggleReset] = useState(0);

  function loadSettings() {
    getSetting("mapBackend").then((value) => {
      if (value === "mapkit" || value === "maplibre") setMapBackend(value);
    });
    getBooleanSetting("autoEndFlight", true).then(setAutoEnd);
    getBooleanSetting("recordInBrowser", false).then(setRecordHere);
  }

  // Phone: re-read on every Ionic view entry (the provider subpage edits
  // the same settings and this page stays mounted behind it). Desktop: no
  // Ionic lifecycle exists, but SettingsRoutes remounts this page per
  // subpage hop, so a mount effect covers the same ground.
  useIonViewWillEnter(() => {
    loadSettings();
  }, []);

  useEffect(() => {
    loadSettings();
    // Loads are idempotent gets; double-firing on phone entry is free.
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
    <IonPage className={settings.page} data-testid="settings-page">
      <IonHeader>
        <IonToolbar>
          <IonTitle>Settings</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent
        className={settings.content}
        data-testid="settings-content"
        fullscreen
      >
        {/* Native iOS large-title collapse, same as the sync sheet: the big
            title rides the content and condenses into the toolbar on
            scroll. The toolbar blends because its --background is the page
            var (theme.css). */}
        <IonHeader collapse="condense">
          <IonToolbar>
            <IonTitle size="large">Settings</IonTitle>
          </IonToolbar>
        </IonHeader>
        {/* Desktop's rail chip IS this row (SYNC-UX.md); saying it twice
            makes two places to glance and one of them stale. */}
        {!isDesktop && (
          <IonList inset>
            <IonItem
              button
              detail
              onClick={openSync}
              data-testid="settings-sync"
            >
              <IonLabel>Sync</IonLabel>
              <IonNote
                slot="end"
                className={cx(styles.note, SETTINGS_TONE_CLASS[described.tone])}
              >
                {off && <IonIcon icon={closeCircle} aria-hidden="true" />}
                {!off && syncBusy && (
                  <IonSpinner name="crescent" aria-hidden="true" />
                )}
                {!off && !syncBusy && syncNote === "On" && (
                  <IonIcon icon={checkmarkOutline} aria-hidden="true" />
                )}
                {syncNote}
              </IonNote>
            </IonItem>
          </IonList>
        )}

        {/* Recording settings only exist where recording does: on the web
            the section appears once "Record in this browser" is enabled. */}
        {canRecord && (
          <>
            <div className={settings.listHeader}>Recording</div>
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
          </>
        )}

        <div className={settings.listHeader}>General</div>
        <IonList inset>
          <IonItem
            button
            detail
            onClick={() => history.push("/settings/appearance")}
            data-testid="settings-appearance"
          >
            <IonLabel>Appearance</IonLabel>
            <IonNote slot="end">
              {appearance === "auto" ? "Auto" : "Dark"}
            </IonNote>
          </IonItem>
          <IonItem
            button
            detail
            onClick={() => history.push("/settings/units")}
          >
            <IonLabel>Units</IonLabel>
            <IonNote slot="end">
              {units === "metric" ? "Metric" : "Imperial"}
            </IonNote>
          </IonItem>
        </IonList>

        <div className={settings.listHeader}>Advanced</div>
        <IonList inset>
          {/* Apple's pick-one idiom: the row shows the current value and
              pushes a checkmark list. */}
          <IonItem button detail onClick={() => history.push("/settings/map")}>
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
          <div className={settings.helperText}>
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
          <IonNote>
            {`Wingover ${__APP_VERSION__}${
              __APP_GIT_SHA__ ? ` (${__APP_GIT_SHA__})` : ""
            } · AGPL-3.0`}
          </IonNote>
        </div>
      </IonContent>
    </IonPage>
  );
}
