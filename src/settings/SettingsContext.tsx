import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import type { Units } from "../flight/format";
import { getSetting, setSetting } from "../storage/db";

interface SettingsValue {
  units: Units;
  setUnits: (units: Units) => void;
}

const SettingsContext = createContext<SettingsValue>({
  units: "imperial",
  setUnits: () => {},
});

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [units, setUnitsState] = useState<Units>("imperial");

  useEffect(() => {
    getSetting("units").then((value) => {
      if (value === "metric" || value === "imperial") setUnitsState(value);
    });
  }, []);

  function setUnits(value: Units) {
    setUnitsState(value);
    setSetting("units", value);
  }

  return (
    <SettingsContext.Provider value={{ units, setUnits }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  return useContext(SettingsContext);
}
