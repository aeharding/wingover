import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";

import type { Units } from "../../flight/format";
import { getSetting, setSetting } from "../../storage/local";
import { type Appearance, normalizeAppearance } from "../appearance";

interface SettingsValue {
  units: Units;
  setUnits: (units: Units) => void;
  appearance: Appearance;
  setAppearance: (appearance: Appearance) => void;
}

const SettingsContext = createContext<SettingsValue>({
  units: "imperial",
  setUnits: () => {},
  // Dark is the default; a fresh install with nothing stored is dark.
  appearance: "dark",
  setAppearance: () => {},
});

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [units, setUnitsState] = useState<Units>("imperial");
  const [appearance, setAppearanceState] = useState<Appearance>("dark");

  useEffect(() => {
    getSetting("units").then((value) => {
      if (value === "metric" || value === "imperial") setUnitsState(value);
    });
    getSetting("appearance").then((value) =>
      setAppearanceState(normalizeAppearance(value)),
    );
  }, []);

  function setUnits(value: Units) {
    setUnitsState(value);
    setSetting("units", value);
  }

  // setSetting fires appTheme's live listener, so the palette re-derives the
  // instant this writes — no reload (hard reloads are forbidden in this app).
  function setAppearance(value: Appearance) {
    setAppearanceState(value);
    setSetting("appearance", value);
  }

  return (
    <SettingsContext.Provider
      value={{ units, setUnits, appearance, setAppearance }}
    >
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  return useContext(SettingsContext);
}
