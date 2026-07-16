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
import { useSyncSheets } from "../sync/SyncSheets";

export default function SettingsPage() {
  const { units, setUnits } = useSettings();
  const { openSubscription, openLogin } = useSyncSheets();
  const syncStatus = useSyncExternalStore(sync.subscribe, sync.currentStatus);
  const account = useSyncExternalStore(sync.subscribe, sync.currentAccount);
  const loggedIn = syncStatus.state !== "off";
  const [appleSub, setAppleSub] = useState<"active" | "expired" | null>(null);

  useEffect(() => {
    void sync.appleSubscriptionState().then(setAppleSub);
  }, []);

  // Subscription is the payments rail (SYNC-UX.md), and its note reflects the
  // RAIL, not the login: StoreKit outranks the held credential, so the
  // supporter (paying while self-hosting) and the lapsed pilot who turned
  // sync off still read the truth instead of a dash. With no subscription at
  // all, the note says what that MEANS for the flights: "Local Only", red,
  // unless something else (self-host) is backing them up.
  const backedUp = ["syncing", "paused", "connecting"].includes(
    syncStatus.state,
  );
  const subscriptionNote =
    appleSub === "active"
      ? "Active"
      : account?.kind === "apple" && syncStatus.state !== "unsubscribed"
        ? account.entitled
          ? "Active"
          : "Expired"
        : appleSub === "expired"
          ? "Expired"
          : backedUp
            ? "—"
            : "Local Only";
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
          <IonItem
            button
            detail
            onClick={openSubscription}
            data-testid="settings-subscription"
          >
            <IonLabel>Subscription</IonLabel>
            <IonNote
              slot="end"
              color={subscriptionNote === "Local Only" ? "danger" : undefined}
            >
              {subscriptionNote}
            </IonNote>
          </IonItem>
          {/* The label never changes — a row that renames itself after a
              purchase reads as the row disappearing. State lives in the note. */}
          <IonItem
            button
            detail
            onClick={openLogin}
            data-testid="settings-login"
          >
            <IonLabel>Log In</IonLabel>
            {loggedIn && (
              <IonNote slot="end">{describeSync(syncStatus).label}</IonNote>
            )}
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
