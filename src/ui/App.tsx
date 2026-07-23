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
import { isTauri } from "../engine/platform";
import DesktopShell from "./desktop/DesktopShell";
import FlightSurface from "./flight/FlyPage";
import AllFlightsMapPage from "./pages/AllFlightsMapPage";
import AppearancePage from "./pages/AppearancePage";
import FlightDetailPage from "./pages/FlightDetailPage";
import FlyFrame from "./pages/FlyFrame";
import LogbookPage from "./pages/LogbookPage";
import MapProviderPage from "./pages/MapProviderPage";
import PlanPage from "./pages/PlanPage";
import SettingsPage from "./pages/SettingsPage";
import UnitsPage from "./pages/UnitsPage";
import { SettingsProvider } from "./settings/SettingsContext";
import { SyncSheetsProvider } from "./sync/SyncSheets";
import { useCanRecord } from "./useCanRecord";
import { useIsDesktop } from "./useIsDesktop";

setupIonicReact({
  mode: "ios",
  // Ionic's input scroll assist is UA-gated, so it also engages inside the
  // Tauri WKWebView — where it fights the native keyboard plumbing: it clones
  // the focused input and scrolls to a hard-coded 290px keyboard estimate
  // after a 1s timeout (it never gets the Capacitor keyboard events it waits
  // for). Native resizes <ion-app> for real (src/tauri-ionic/keyboard.ts) and
  // pages scroll the focused field themselves, so switch it off there. The
  // PWA keeps it — no webview resize happens there, the assist IS the
  // mechanism. Of Ionic's other iOS input shims, hideCaretOnScroll stays ON
  // deliberately (WKWebView's native caret layer lags scrolling; hiding it
  // mid-scroll is Capacitor's shipped behavior) and inputBlurring defaults
  // off in Ionic 8.
  scrollAssist: !isTauri(),
  // Tapping the status bar scrolls the visible content to top, like every
  // native app. tauri-plugin-ionic dispatches Capacitor's `statusTap` window
  // event; this opts in Ionic's built-in handler for it (its default is
  // hybrid-only, which Tauri isn't in Ionic's eyes). Off on the PWA — no
  // native event source exists there.
  statusTap: isTauri(),
});

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
            <Route exact path="/fly" component={FlyFrame} />
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
          <Route exact path="/settings/appearance" component={AppearancePage} />
          <Route
            exact
            path="/home"
            render={({ location }) => (
              <Redirect to={{ pathname: "/", search: location.search }} />
            )}
          />
          <Route
            exact
            path="/"
            render={({ location }) => (
              // Carry the query through: ?mock-speed / ?map / ?mock-home are
              // read on load, and dropping them here means a reload (or an
              // HMR refresh) lands on a bare /fly and silently loses the mock
              // engine or map override.
              <Redirect
                to={{
                  pathname: canRecord ? "/fly" : "/logbook",
                  search: location.search,
                }}
              />
            )}
          />
        </IonRouterOutlet>
        {/* translucent: the Fly splash paints under the bar (its content is
            fullscreen) and frosts through; other tabs' content stays inside
            the page, where the 80%-alpha bar over the same-color shell is
            indistinguishable from opaque. */}
        <IonTabBar slot="bottom" translucent>
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
