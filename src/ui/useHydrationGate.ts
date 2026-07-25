import { useEffect, useState } from "react";

import { engine } from "../engine";

/**
 * Before the WAL read the engine reports "idle". The app root renders
 * NOTHING until the engine has spoken, so no surface can flash the wrong
 * state during a mid-flight relaunch; the body paints the palette color.
 */
export function useHydrationGate(): boolean {
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    void engine.getSnapshot().then(() => setHydrated(true));
  }, []);

  return hydrated;
}
