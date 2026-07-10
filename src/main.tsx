import "@ionic/react/css/core.css";
import "@ionic/react/css/normalize.css";
import "@ionic/react/css/structure.css";
import "@ionic/react/css/typography.css";
import "@ionic/react/css/palettes/dark.always.css";
import "./theme.css";

import { createRoot } from "react-dom/client";

import App from "./ui/App";

createRoot(document.getElementById("root")!).render(<App />);
