import { IonIcon } from "@ionic/react";
import {
  bookOutline,
  mapOutline,
  navigateOutline,
  settingsOutline,
} from "ionicons/icons";
import { useState } from "react";
import {
  BrowserRouter,
  NavLink,
  Redirect,
  useLocation,
} from "react-router-dom";

import FlyPage from "../pages/FlyPage";
import MapProviderPage from "../pages/MapProviderPage";
import PlanPage from "../pages/PlanPage";
import SettingsPage from "../pages/SettingsPage";
import UnitsPage from "../pages/UnitsPage";
import { useCanRecord } from "../useCanRecord";
import LogbookSection from "./LogbookSection";

/**
 * The desktop app is its own shell: plain react-router (no Ionic outlet),
 * a left rail, and hand-rolled keep-alive for the tab sections. The Ionic
 * outlet's page transitions and view-item caching are phone furniture; on
 * desktop they caused full remounts (list scroll lost, maps re-created)
 * for every selection. Ionic COMPONENTS still render everything inside —
 * only the navigation machinery is ours. Phones keep the untouched Ionic
 * tab shell (see App.tsx).
 */
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
  const { pathname } = useLocation();
  const section = sectionOf(pathname);
  // Sections mount on first visit and then stay alive hidden — tab
  // switches must not tear down the plan map or the logbook split. First
  // mount happens while VISIBLE, so maps never initialize at 0x0. A
  // stable Set instance (never re-set) mutated idempotently during
  // render: same result on every re-render, including strict-mode
  // doubles.
  const [visited] = useState(() => new Set<Section>());

  if (!section) return <Redirect to={canRecord ? "/fly" : "/logbook"} />;
  if (section === "fly" && !canRecord) return <Redirect to="/logbook" />;
  visited.add(section);

  return (
    <div className="desktop-shell">
      <nav className="desktop-rail">
        <a className="rail-brand" href="/" aria-label="About Wingover">
          <img src="/icon-192.png" alt="" width="36" height="36" />
        </a>
        {canRecord && (
          <NavLink
            className="rail-link"
            activeClassName="active"
            to="/fly"
            data-testid="rail-fly"
          >
            <IonIcon icon={navigateOutline} />
            <span>Fly</span>
          </NavLink>
        )}
        <NavLink
          className="rail-link"
          activeClassName="active"
          to="/logbook"
          data-testid="rail-logbook"
        >
          <IonIcon icon={bookOutline} />
          <span>Logbook</span>
        </NavLink>
        <NavLink
          className="rail-link"
          activeClassName="active"
          to="/plan"
          data-testid="rail-plan"
        >
          <IonIcon icon={mapOutline} />
          <span>Plan</span>
        </NavLink>
        <NavLink
          className="rail-link"
          activeClassName="active"
          to="/settings"
          data-testid="rail-settings"
        >
          <IonIcon icon={settingsOutline} />
          <span>Settings</span>
        </NavLink>
      </nav>
      <main className="desktop-main">
        {canRecord && visited.has("fly") && (
          <section className="shell-section" hidden={section !== "fly"}>
            <FlyPage />
          </section>
        )}
        {visited.has("logbook") && (
          <section className="shell-section" hidden={section !== "logbook"}>
            <LogbookSection />
          </section>
        )}
        {visited.has("plan") && (
          <section className="shell-section" hidden={section !== "plan"}>
            <PlanPage />
          </section>
        )}
        {visited.has("settings") && (
          <section className="shell-section" hidden={section !== "settings"}>
            <SettingsRoutes />
          </section>
        )}
      </main>
    </div>
  );
}

// Settings sub-navigation without an outlet: cheap pages, plain switch.
function SettingsRoutes() {
  const { pathname } = useLocation();
  if (pathname === "/settings/map") return <MapProviderPage />;
  if (pathname === "/settings/units") return <UnitsPage />;
  return <SettingsPage />;
}
