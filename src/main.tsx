import "@ionic/react/css/core.css";
import "@ionic/react/css/normalize.css";
import "@ionic/react/css/structure.css";
import "@ionic/react/css/typography.css";
import "@ionic/react/css/palettes/dark.always.css";
import "./theme.css";

import { createRoot } from "react-dom/client";

import { resume } from "./sync";
import App from "./ui/App";
import { installExternalLinkHandler } from "./ui/externalLinks";
import { captureLaunchUrl } from "./ui/map/config";

installExternalLinkHandler();
// Pin launch-only URL flags before the router can strip the query string.
captureLaunchUrl();
// Mark this browser as "has used the app": the landing page (public/
// landing.html, served at / on wingover.app) checks this flag and forwards
// returning pilots straight to /logbook before paint.
try {
  localStorage.setItem("wingover.used", "1");
} catch {
  // Storage unavailable (private mode); the landing just shows instead.
}
// Sync that stops at the end of the session isn't sync. Fire-and-forget: the
// credential is on disk or it isn't, and nothing here should delay first paint.
void resume();

createRoot(document.getElementById("root")!).render(<App />);
