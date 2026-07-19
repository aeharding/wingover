import "@ionic/react/css/core.css";
import "@ionic/react/css/normalize.css";
import "@ionic/react/css/structure.css";
import "@ionic/react/css/typography.css";
import "@ionic/react/css/palettes/dark.always.css";
import "./theme.css";

import { createRoot } from "react-dom/client";

import { stripMintedFlightNames } from "./storage/db";
import { resume } from "./sync";
import App from "./ui/App";
import { installExternalLinkHandler } from "./ui/externalLinks";
import { captureLaunchUrl } from "./ui/map/config";

installExternalLinkHandler();
// Pin launch-only URL flags before the router can strip the query string.
captureLaunchUrl();
// Sync that stops at the end of the session isn't sync. Fire-and-forget: the
// credential is on disk or it isn't, and nothing here should delay first paint.
void resume();
// Strip the datetime names old builds minted into recorded flights; see
// stripMintedFlightNames. Fire-and-forget, like resume: first paint never
// waits on a data pass.
void stripMintedFlightNames();

createRoot(document.getElementById("root")!).render(<App />);
