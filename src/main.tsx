import "@ionic/react/css/core.css";
import "@ionic/react/css/normalize.css";
import "@ionic/react/css/structure.css";
import "@ionic/react/css/typography.css";
import "@ionic/react/css/palettes/dark.class.css";
import "./theme.css";

import { createRoot } from "react-dom/client";

// Side effect: the engine-side foreground recovery wiring must run from
// boot, not from whichever page happens to import it first.
import "./engine/session";
import { stripMintedFlightNames } from "./storage/db";
import { resume } from "./sync";
import { installCapacitorShim, installKeyboardLayout } from "./tauri-ionic";
import App from "./ui/App";
import { initAppTheme } from "./ui/app/appTheme";
import { initSatelliteAvailability } from "./ui/app/map/satelliteAvailability";
import { installExternalLinkHandler } from "./ui/shared/externalLinks";
import { captureLaunchUrl } from "./ui/shared/map/config";

installExternalLinkHandler();
// Collection runs engine-side (engine/session.ts) and has one thing to tell
// the pilot. Subscribed here, outside React, because it reports whether or
// not any surface is mounted — including with the crash screen up in place of
// the flight surface. No report can be missed before this line: the earliest
// collection waits on the WAL read, and module bodies finish before the first
// microtask does.
// Resize <ion-app> and flag html.keyboard-open when tauri-plugin-ionic
// reports the on-screen keyboard (dormant off-device).
installKeyboardLayout();
// window.Capacitor facade → Ionic's built-in haptics (toggles, pickers,
// refresher) fire through tauri-plugin-haptics. No-op off-device.
installCapacitorShim();
// Pin launch-only URL flags before the router can strip the query string.
captureLaunchUrl();
// Stamp ion-palette-dark on <html> (system scheme OR satellite view) before
// first render — palettes/dark.class.css and every scheme-aware rule key
// off that class, not prefers-color-scheme.
initAppTheme();
// A stored satellite view the active backend cannot render would otherwise pin
// the palette dark with no visible toggle to undo it.
initSatelliteAvailability();
// Sync that stops at the end of the session isn't sync. Fire-and-forget: the
// credential is on disk or it isn't, and nothing here should delay first paint.
void resume();
// Strip the datetime names old builds minted into recorded flights; see
// stripMintedFlightNames. Fire-and-forget, like resume: first paint never
// waits on a data pass.
void stripMintedFlightNames();

createRoot(document.getElementById("root")!).render(<App />);
