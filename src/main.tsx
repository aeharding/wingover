import "@ionic/react/css/core.css";
import "@ionic/react/css/normalize.css";
import "@ionic/react/css/structure.css";
import "@ionic/react/css/typography.css";
import "@ionic/react/css/palettes/dark.class.css";
import "./theme.css";

import { createRoot } from "react-dom/client";

import { stripMintedFlightNames } from "./storage/db";
import { resume } from "./sync";
import { installCapacitorShim, installKeyboardLayout } from "./tauri-ionic";
import App from "./ui/App";
import { initAppTheme } from "./ui/appTheme";
import { installExternalLinkHandler } from "./ui/externalLinks";
import { captureLaunchUrl } from "./ui/map/config";

installExternalLinkHandler();
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
// Sync that stops at the end of the session isn't sync. Fire-and-forget: the
// credential is on disk or it isn't, and nothing here should delay first paint.
void resume();
// Strip the datetime names old builds minted into recorded flights; see
// stripMintedFlightNames. Fire-and-forget, like resume: first paint never
// waits on a data pass.
void stripMintedFlightNames();

createRoot(document.getElementById("root")!).render(<App />);
