import {
  IonBackButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonInput,
  IonItem,
  IonList,
  IonPage,
  IonRadio,
  IonRadioGroup,
  IonTitle,
  IonToolbar,
} from "@ionic/react";
import { useEffect, useState } from "react";

import { getSetting, setSetting } from "../../storage/local";

import "./SettingsPage.css";

/**
 * The map engine, pilot-chosen (Apple checkmark-list idiom, see UnitsPage).
 * MapKit is the default: Apple imagery, satellite included, free. MapLibre
 * is the FOSS path: keyless OpenFreeMap streets, satellite only with the
 * pilot's own MapTiler key — first-party map costs stay zero either way.
 */
export default function MapProviderPage() {
  const [backend, setBackend] = useState("mapkit");
  const [maptilerKey, setMaptilerKey] = useState("");

  useEffect(() => {
    getSetting("mapBackend").then((value) => {
      if (value === "mapkit" || value === "maplibre") setBackend(value);
    });
    getSetting("maptilerKey").then((value) => setMaptilerKey(value ?? ""));
  }, []);

  function saveBackend(value: string) {
    if (value !== "mapkit" && value !== "maplibre") return;
    setBackend(value);
    setSetting("mapBackend", value);
  }

  function saveMaptilerKey(value: string) {
    setMaptilerKey(value);
    setSetting("maptilerKey", value);
  }

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <IonBackButton defaultHref="/settings" text="Settings" />
          </IonButtons>
          <IonTitle>Map Provider</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent className="settings-content">
        <IonList inset>
          <IonRadioGroup
            value={backend}
            onIonChange={(event) => {
              if (typeof event.detail.value === "string")
                saveBackend(event.detail.value);
            }}
          >
            <IonItem>
              <IonRadio value="mapkit">MapKit</IonRadio>
            </IonItem>
            <IonItem>
              <IonRadio value="maplibre">MapLibre</IonRadio>
            </IonItem>
          </IonRadioGroup>
        </IonList>
        <div className="settings-helper-text">
          {backend === "maplibre"
            ? "Streets are free via OpenFreeMap."
            : "Apple maps, satellite imagery included."}
        </div>

        {backend === "maplibre" && (
          <>
            <IonList inset>
              <IonItem>
                <IonInput
                  label="MapTiler key"
                  placeholder="Key"
                  value={maptilerKey}
                  onIonInput={(event) =>
                    saveMaptilerKey(event.detail.value ?? "")
                  }
                />
              </IonItem>
            </IonList>
            <div className="settings-helper-text">
              A free key from maptiler.com adds satellite view.
            </div>
          </>
        )}
      </IonContent>
    </IonPage>
  );
}
