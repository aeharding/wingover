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
import { SyncSheetsProvider } from "./sync/SyncSheets";

setupIonicReact({ mode: "ios" });

export default function App() {
  useEffect(() => {
    // Kick the one-time WAL hydration (idempotent; FlyPage kicks it too).
    void engine.getSnapshot();
  }, []);

  return (
    <IonApp>
      <SettingsProvider>
        {/* Mounted above AppBody, which sheds the whole nav shell during a
            flight — the sheets outlive that, so either can be raised from
            anywhere without each page owning a modal. */}
        <SyncSheetsProvider>
          <AppBody />
        </SyncSheetsProvider>
      </SettingsProvider>
    </IonApp>
  );
}

// A live flight sheds the entire Ionic navigation shell — tab bar, router,
// router-outlet, and every other tab's page. Ionic's router-outlet otherwise
// keeps each visited page mounted, and the map-bearing ones (Plan, Logbook,
// flight detail) each hold a live map + tile cache the whole time — the
// WKWebView ballooning to 500–850 MB is what gets the app jetsammed mid-flight.
// Rendering only <FlyPage> in flight makes the footprint the single live map
// and nothing else. The tab bar is unreachable during a flight anyway, so this
// is invisible to the pilot, and the full shell returns the instant the flight
// ends. "idle" is the only non-flight state; pre-hydration the engine reports
// it, so the shell shows during load.
function AppBody() {
  const inFlight = useSyncExternalStore(
    engine.subscribe,
    () => engine.snapshotSync().status !== "idle",
  );
  if (inFlight) return <FlyPage />;
  return <TabShell />;
}

function TabShell() {
  return (
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
        <IonTabBar slot="bottom">
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
  );
}
