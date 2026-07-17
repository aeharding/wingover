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
import DesktopShell from "./desktop/DesktopShell";
import FlightSurface from "./flight/FlyPage";
import AllFlightsMapPage from "./pages/AllFlightsMapPage";
import FlightDetailPage from "./pages/FlightDetailPage";
import FlyPage from "./pages/FlyPage";
import LogbookPage from "./pages/LogbookPage";
import MapProviderPage from "./pages/MapProviderPage";
import PlanPage from "./pages/PlanPage";
import SettingsPage from "./pages/SettingsPage";
import UnitsPage from "./pages/UnitsPage";
import { SettingsProvider } from "./settings/SettingsContext";
import { SyncSheetsProvider } from "./sync/SyncSheets";
import { useCanRecord } from "./useCanRecord";
import { useIsDesktop } from "./useIsDesktop";

import "./desktop.css";

setupIonicReact({ mode: "ios" });

export default function App() {
  useEffect(() => {
    // Kick the one-time WAL hydration (idempotent; FlyPage kicks it too).
    void engine.getSnapshot();
  }, []);

  return (
    <SettingsProvider>
      <AppBody />
    </SettingsProvider>
  );
}

// A live flight sheds the entire Ionic navigation shell — tab bar, router,
// router-outlet, and every other tab's page. Ionic's router-outlet otherwise
// keeps each visited page mounted, and the map-bearing ones (Plan, Logbook,
// flight detail) each hold a live map + tile cache the whole time — the
// WKWebView ballooning to 500–850 MB is what gets the app jetsammed mid-flight.
// Rendering only the flight surface in flight makes the footprint the single
// live map and nothing else. The tab bar is unreachable during a flight
// anyway, so this is invisible to the pilot, and the full shell returns the
// instant the flight ends. "idle" is the only non-flight state;
// pre-hydration the engine reports it, so the shell shows during load.
//
// Shed means SHED: ion-app itself goes too. The flight surface is a plain
// div tree (src/ui/flight, Ionic-free by lint), so while recording, Ionic
// simply does not exist in the DOM. IonApp and the sheets remount with the
// shell when the flight ends.
function AppBody() {
  const inFlight = useSyncExternalStore(
    engine.subscribe,
    () => engine.snapshotSync().status !== "idle",
  );
  const isDesktop = useIsDesktop();
  if (inFlight) return <FlightSurface />;
  // Desktop gets its own shell: plain react-router, no Ionic outlet (see
  // DesktopShell). Phones keep the Ionic tab shell untouched.
  return (
    <IonApp>
      {/* Above the shells, so a sheet can be raised from anywhere without
          each page owning a modal; inside IonApp, because IonModal
          presents against it. */}
      <SyncSheetsProvider>
        {isDesktop ? <DesktopShell /> : <TabShell />}
      </SyncSheetsProvider>
    </IonApp>
  );
}

function TabShell() {
  const canRecord = useCanRecord();
  return (
    <IonReactRouter>
      <IonTabs>
        <IonRouterOutlet>
          {/* Gated as a ROUTE, not just a tab: a bookmarked /fly in a plain
              browser is the same broken promise as a visible tab. Safe to
              gate because the opt-in is mirrored to localStorage, so
              canRecord is correct synchronously at first render. */}
          {canRecord ? (
            <Route exact path="/fly" component={FlyPage} />
          ) : (
            <Route exact path="/fly">
              <Redirect to="/logbook" />
            </Route>
          )}
          <Route exact path="/logbook" component={LogbookPage} />
          <Route exact path="/logbook/map" component={AllFlightsMapPage} />
          <Route
            exact
            path="/logbook/:id(recorded-\d+|[0-9a-fA-F-]{36})"
            component={FlightDetailPage}
          />
          <Route exact path="/plan" component={PlanPage} />
          <Route exact path="/settings" component={SettingsPage} />
          <Route exact path="/settings/map" component={MapProviderPage} />
          <Route exact path="/settings/units" component={UnitsPage} />
          <Route exact path="/">
            <Redirect to={canRecord ? "/fly" : "/logbook"} />
          </Route>
        </IonRouterOutlet>
        <IonTabBar slot="bottom">
          {canRecord && (
            <IonTabButton tab="fly" href="/fly">
              <IonIcon icon={navigateOutline} />
              <IonLabel>Fly</IonLabel>
            </IonTabButton>
          )}
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
