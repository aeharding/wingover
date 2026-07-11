import {
  IonApp,
  IonIcon,
  IonLabel,
  IonRouterOutlet,
  IonTabBar,
  IonTabButton,
  IonTabs,
  setupIonicReact,
} from "@ionic/react";
import { IonReactRouter } from "@ionic/react-router";
import {
  bookOutline,
  mapOutline,
  navigateOutline,
  settingsOutline,
} from "ionicons/icons";
import { useEffect, useSyncExternalStore } from "react";
import { Redirect, Route } from "react-router-dom";

import { engine } from "../engine";
import AllFlightsMapPage from "./pages/AllFlightsMapPage";
import FlightDetailPage from "./pages/FlightDetailPage";
import FlyPage from "./pages/FlyPage";
import LogbookPage from "./pages/LogbookPage";
import PlanPage from "./pages/PlanPage";
import SettingsPage from "./pages/SettingsPage";
import { SettingsProvider } from "./settings/SettingsContext";

setupIonicReact({ mode: "ios" });

export default function App() {
  // Pre-hydration the engine reports "idle", so the tab bar shows during
  // load and hides once a live session hydrates — same as before.
  const inFlight = useSyncExternalStore(
    engine.subscribe,
    () => engine.snapshotSync().status !== "idle",
  );

  useEffect(() => {
    // Kick the one-time WAL hydration (idempotent; FlyPage kicks it too).
    void engine.getSnapshot();
  }, []);

  return (
    <IonApp>
      <SettingsProvider>
        <IonReactRouter>
          <IonTabs>
            <IonRouterOutlet>
              <Route exact path="/fly" component={FlyPage} />
              <Route exact path="/logbook" component={LogbookPage} />
              <Route exact path="/logbook/map" component={AllFlightsMapPage} />
              <Route
                exact
                path="/logbook/:id(recorded-\d+|[0-9a-fA-F-]{36})"
                component={FlightDetailPage}
              />
              <Route exact path="/plan" component={PlanPage} />
              <Route exact path="/settings" component={SettingsPage} />
              <Route exact path="/">
                <Redirect to="/fly" />
              </Route>
            </IonRouterOutlet>
            <IonTabBar
              slot="bottom"
              className={inFlight ? "tab-bar-hidden" : undefined}
            >
              <IonTabButton tab="fly" href="/fly">
                <IonIcon icon={navigateOutline} />
                <IonLabel>Fly</IonLabel>
              </IonTabButton>
              <IonTabButton tab="logbook" href="/logbook">
                <IonIcon icon={bookOutline} />
                <IonLabel>Logbook</IonLabel>
              </IonTabButton>
              <IonTabButton tab="plan" href="/plan">
                <IonIcon icon={mapOutline} />
                <IonLabel>Plan</IonLabel>
              </IonTabButton>
              <IonTabButton tab="settings" href="/settings">
                <IonIcon icon={settingsOutline} />
                <IonLabel>Settings</IonLabel>
              </IonTabButton>
            </IonTabBar>
          </IonTabs>
        </IonReactRouter>
      </SettingsProvider>
    </IonApp>
  );
}
