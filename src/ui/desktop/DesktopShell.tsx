import {
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonPopover,
  IonSpinner,
  useIonAlert,
} from "@ionic/react";
import {
  bookOutline,
  checkmarkOutline,
  closeCircle,
  mapOutline,
  navigateOutline,
  settingsOutline,
  syncOutline,
} from "ionicons/icons";
import { useState, useSyncExternalStore } from "react";
import {
  BrowserRouter,
  NavLink,
  Redirect,
  useLocation,
} from "react-router-dom";

import { isTauri } from "../../engine/platform";
import { resetSyncedData } from "../../storage/db";
import * as sync from "../../sync";
import { cx } from "../cx";
import FlyPage from "../flight/FlyPage";
import FlySplash from "../flight/FlySplash";
import { useFlights } from "../logbook/useFlights";
import AppearancePage from "../pages/AppearancePage";
import MapProviderPage from "../pages/MapProviderPage";
import PlanPage from "../pages/PlanPage";
import SettingsPage from "../pages/SettingsPage";
import UnitsPage from "../pages/UnitsPage";
import { describe, type SyncTone } from "../sync/describe";
import { useSyncSheet } from "../sync/SyncSheets";
import { useLogOut } from "../sync/useLogOut";
import { useCanRecord } from "../useCanRecord";
import LogbookSection from "./LogbookSection";

import styles from "./DesktopShell.module.css";

/**
 * The desktop app is its own shell: plain react-router (no Ionic outlet),
 * a left rail, and hand-rolled keep-alive for the tab sections. The Ionic
 * outlet's page transitions and view-item caching are phone furniture; on
 * desktop they caused full remounts (list scroll lost, maps re-created)
 * for every selection. Ionic COMPONENTS still render everything inside —
 * only the navigation machinery is ours. Phones keep the untouched Ionic
 * tab shell (see App.tsx).
 */
// Semantic tone → the rail chip's color class. Shared with the Settings row and
// the sheet via describe(), so all three agree — the chip no longer paints every
// non-On/Off state (a normal in-flight pause, a dormant account, an error) amber.
const RAIL_TONE_CLASS: Record<SyncTone, string> = {
  on: styles.on,
  off: styles.off,
  warn: styles.warn,
  error: styles.error,
  neutral: styles.neutral,
};

export default function DesktopShell() {
  return (
    <BrowserRouter>
      <DesktopFrame />
    </BrowserRouter>
  );
}

type Section = "fly" | "logbook" | "plan" | "settings";

function sectionOf(pathname: string): Section | null {
  if (pathname.startsWith("/fly")) return "fly";
  if (pathname.startsWith("/logbook")) return "logbook";
  if (pathname.startsWith("/plan")) return "plan";
  if (pathname.startsWith("/settings")) return "settings";
  return null;
}

function DesktopFrame() {
  const canRecord = useCanRecord();
  const { pathname, search } = useLocation();
  const section = sectionOf(pathname);
  // Sections mount on first visit and then stay alive hidden — tab
  // switches must not tear down the plan map or the logbook split. First
  // mount happens while VISIBLE, so maps never initialize at 0x0. A
  // stable Set instance (never re-set) mutated idempotently during
  // render: same result on every re-render, including strict-mode
  // doubles.
  const [visited] = useState(() => new Set<Section>());

  // Carry the query through so ?mock-speed / ?map / ?mock-home survive the
  // index redirect (and any reload landing back on it).
  if (!section)
    return (
      <Redirect to={{ pathname: canRecord ? "/fly" : "/logbook", search }} />
    );
  if (section === "fly" && !canRecord) return <Redirect to="/logbook" />;
  visited.add(section);

  return (
    <div className={styles.shell}>
      <nav className={styles.rail} data-testid="desktop-rail">
        <a
          className={styles.brand}
          href="/"
          aria-label="About Wingover"
          data-testid="rail-brand"
        >
          <img src="/icon-192.png" alt="" width="36" height="36" />
        </a>
        {canRecord && (
          <NavLink
            className={styles.link}
            activeClassName={styles.active}
            to="/fly"
            data-testid="rail-fly"
          >
            <IonIcon icon={navigateOutline} />
            <span>Fly</span>
          </NavLink>
        )}
        <NavLink
          className={styles.link}
          activeClassName={styles.active}
          to="/logbook"
          data-testid="rail-logbook"
        >
          <IonIcon icon={bookOutline} />
          <span>Logbook</span>
        </NavLink>
        <NavLink
          className={styles.link}
          activeClassName={styles.active}
          to="/plan"
          data-testid="rail-plan"
        >
          <IonIcon icon={mapOutline} />
          <span>Plan</span>
        </NavLink>
        <NavLink
          className={styles.link}
          activeClassName={styles.active}
          to="/settings"
          data-testid="rail-settings"
        >
          <IonIcon icon={settingsOutline} />
          <span>Settings</span>
        </NavLink>
        <RailSync />
      </nav>
      <main className={styles.main} data-testid="desktop-main">
        {canRecord && visited.has("fly") && (
          <section className={styles.section} hidden={section !== "fly"}>
            {/* The splash backdrop behind the frameless surface — same
                element the phone frame uses as its content background. */}
            <FlySplash />
            <FlyPage />
          </section>
        )}
        {visited.has("logbook") && (
          <section className={styles.section} hidden={section !== "logbook"}>
            <LogbookSection />
          </section>
        )}
        {visited.has("plan") && (
          <section className={styles.section} hidden={section !== "plan"}>
            <PlanPage />
          </section>
        )}
        {visited.has("settings") && (
          <section className={styles.section} hidden={section !== "settings"}>
            <SettingsRoutes />
          </section>
        )}
      </main>
    </div>
  );
}

/**
 * The rail's bottom chip: one glance answers "are my flights backed up"
 * (spinning while docs actually move), and a click opens the traditional
 * account menu: status, Manage sync (the sheet), and Log out on the web.
 * Settings carries no Sync row on desktop; this chip IS the row
 * (SYNC-UX.md).
 */
function RailSync() {
  const openSync = useSyncSheet();
  const status = useSyncExternalStore(sync.subscribe, sync.currentStatus);
  // Controlled, not trigger="rail-sync": Ionic resolves a string trigger on
  // load, before the sibling chip's element is registered, and warns the
  // trigger is missing on every desktop mount. Opening from the click event
  // sidesteps the lookup entirely.
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuEvent, setMenuEvent] = useState<MouseEvent | undefined>(undefined);
  const { logOut, busy } = useLogOut();
  const { flights } = useFlights();
  const [presentAlert] = useIonAlert();
  const off = status.state === "off";
  const { label, detail, tone } = describe(status);
  const active =
    status.state === "connecting" ||
    (status.state === "syncing" && status.active);
  return (
    <>
      <button
        className={cx(styles.link, styles.sync, RAIL_TONE_CLASS[tone])}
        aria-label={`Sync: ${off ? "Off" : label}`}
        data-testid="rail-sync"
        onClick={(e) => {
          setMenuEvent(e.nativeEvent);
          setMenuOpen(true);
        }}
      >
        {active ? (
          <IonSpinner name="crescent" aria-hidden="true" />
        ) : (
          <IonIcon
            icon={
              off
                ? closeCircle
                : label === "On"
                  ? checkmarkOutline
                  : syncOutline
            }
            aria-hidden="true"
          />
        )}
        <span>Sync</span>
      </button>
      <IonPopover
        isOpen={menuOpen}
        event={menuEvent}
        onDidDismiss={() => setMenuOpen(false)}
        side="right"
        alignment="end"
        className={styles.pop}
      >
        <IonList lines="none">
          <IonItem className={styles.state}>
            <IonLabel>
              <h3>Sync: {label}</h3>
              {detail && <p>{detail}</p>}
            </IonLabel>
          </IonItem>
          <IonItem
            button
            detail={false}
            data-testid="rail-sync-manage"
            onClick={() => {
              setMenuOpen(false);
              openSync();
            }}
          >
            <IonLabel>{off ? "Log In" : "Manage sync"}</IonLabel>
          </IonItem>
          {!off && !isTauri() && (
            <IonItem
              button
              detail={false}
              disabled={busy}
              data-testid="rail-sync-logout"
              onClick={() => {
                void logOut(() => setMenuOpen(false));
              }}
            >
              <IonLabel color="danger">Log out</IonLabel>
              {busy && (
                <IonSpinner slot="end" name="crescent" aria-hidden="true" />
              )}
            </IonItem>
          )}
          {/* Log out's dark twin: sync off, yet flights sit on this
              computer (imports, browser recordings, a past session).
              Always confirms, because unlike Log out there is provably
              nothing backing them up. Hidden while connected: destroying
              a synced copy is a lie (it pulls straight back down), and
              the connected verbs are Log out and per-flight delete. */}
          {off && !isTauri() && flights.length > 0 && (
            <IonItem
              button
              detail={false}
              data-testid="rail-sync-erase"
              onClick={() => {
                setMenuOpen(false);
                presentAlert({
                  header: "Delete local data?",
                  message:
                    "Sync is off, so nothing is backed up. This deletes every flight and plan pin stored on this computer, permanently.",
                  buttons: [
                    { text: "Cancel", role: "cancel" },
                    {
                      text: "Delete",
                      role: "destructive",
                      handler: () => {
                        void resetSyncedData();
                      },
                    },
                  ],
                });
              }}
            >
              <IonLabel color="danger">Delete local data</IonLabel>
            </IonItem>
          )}
        </IonList>
      </IonPopover>
    </>
  );
}

// Settings sub-navigation without an outlet: cheap pages, plain switch.
function SettingsRoutes() {
  const { pathname } = useLocation();
  if (pathname === "/settings/map") return <MapProviderPage />;
  if (pathname === "/settings/units") return <UnitsPage />;
  if (pathname === "/settings/appearance") return <AppearancePage />;
  return <SettingsPage />;
}
