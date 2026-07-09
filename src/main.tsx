import { createRoot } from "react-dom/client";

import App from "./App";

import "./theme.css";
import "@ionic/react/css/core.css";
import "@ionic/react/css/normalize.css";
import "@ionic/react/css/palettes/dark.always.css";
import "@ionic/react/css/structure.css";
import "@ionic/react/css/typography.css";

createRoot(document.getElementById("root")!).render(<App />);
